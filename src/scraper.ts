import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { getDb, type DB } from './db/connection.js';
import { saveScrapedAccount, recordScrapeRun } from './db/ingestRepo.js';
import * as readline from 'readline';
import type { Page } from 'puppeteer';
import { existsSync } from 'fs';
import { platform } from 'os';

function findChromePath(): string | undefined {
  const paths: Record<string, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  };

  const platformPaths = paths[platform()] || [];
  for (const p of platformPaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

interface AccountConfig {
  companyId: keyof typeof CompanyTypes;
  credentials: Record<string, string>;
  /** household member the scraped accounts belong to (set in the setup page); applied to accounts that have no owner yet */
  ownerMemberId?: number | null;
}

export interface Config {
  accounts: AccountConfig[];
  /** optional external categorizer: POST {description} → {category} */
  categoryApiUrl?: string;
}

/** Lets a caller (the API's scrape job) run the scrape: answer the OTP and follow progress. */
export interface ScrapeHooks {
  /** asked when the bank shows its OTP screen; defaults to the terminal. '' gives up */
  requestOtp?: (company: string) => Promise<string>;
  onProgress?: (event: ScrapeProgress) => void;
}
export type ScrapeProgress =
  | { type: 'start'; company: string }
  | { type: 'done'; company: string; success: boolean; newTransactions: number; errorType?: string; errorMessage?: string };

async function promptOtp(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n🔐 Enter OTP code (5 digits): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function startOtpWatcher(page: Page, requestOtp: () => Promise<string>): Promise<void> {
  const maxWait = 90000;
  const interval = 1000;
  let waited = 0;
  let otpHandled = false;

  while (waited < maxWait && !otpHandled) {
    try {
      // Check if OTP modal is visible
      const otpModal = await page.$('poalim-separated-characters-input');
      if (otpModal) {
        console.log('\n📱 OTP popup detected!');
        const otp = await requestOtp();
        if (!otp) return;

        // Fill each digit into separate inputs
        const inputs = await page.$$('poalim-separated-characters-input input');
        for (let i = 0; i < Math.min(otp.length, inputs.length); i++) {
          await inputs[i].type(otp[i], { delay: 50 });
        }

        // Click submit button
        const submitBtn = await page.$('button.btn-red_1');
        if (submitBtn) {
          await submitBtn.click();
          console.log('✅ OTP submitted');
        }
        
        otpHandled = true;
        return;
      }

      // Check if we've moved past login (success)
      const url = page.url();
      if (!url.includes('login') && !url.includes('auth')) {
        return; // Login completed without OTP
      }
    } catch {
      // Frame detached or other error - page might have navigated, just continue
    }

    await new Promise(r => setTimeout(r, interval));
    waited += interval;
  }
}

// Describe where the browser ended up, for diagnosing failed logins. Uses visible
// text only (innerText never includes typed input values), so credentials are not logged.
async function describePage(page: Page): Promise<string> {
  const lines = [`  URL: ${page.url()}`];
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText ?? '');
      const compact = text.replace(/\s+/g, ' ').trim().slice(0, 800);
      if (compact) lines.push(`  Visible text [${frame.url().slice(0, 80)}]: ${compact}`);
    } catch {
      // frame detached mid-navigation; skip it
    }
  }
  return lines.join('\n');
}

export interface ScrapeSummary {
  company: string;
  success: boolean;
  newTransactionIds: number[];
  errorType?: string;
}

export async function scrapeAll(config: Config, db: DB = getDb(), hooks: ScrapeHooks = {}): Promise<ScrapeSummary[]> {
  // SCRAPE_FROM=2026-01-01 fetches from that date (backfill); otherwise the last 3 months
  const startDate = process.env.SCRAPE_FROM ? new Date(`${process.env.SCRAPE_FROM}T00:00:00`) : new Date();
  if (Number.isNaN(startDate.getTime())) throw new Error(`SCRAPE_FROM is not a date: ${process.env.SCRAPE_FROM}`);
  if (!process.env.SCRAPE_FROM) startDate.setMonth(startDate.getMonth() - 3);

  // SCRAPE_ONLY=visaCal,leumi limits the run to those companies
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const summaries: ScrapeSummary[] = [];

  for (const account of config.accounts) {
    if (only && !only.includes(account.companyId)) continue;
    console.log(`Scraping ${account.companyId}...`);
    hooks.onProgress?.({ type: 'start', company: account.companyId });
    const startedAt = new Date().toISOString();
    let pageStateAtClose: string | undefined;

    try {
      const scraper = createScraper({
        companyId: CompanyTypes[account.companyId],
        startDate,
        futureMonthsToScrape: 2, // upcoming card charges and future installments
        // per-transaction detail requests (e.g. Isracard PirteyIska_204) get rate-limited (HTTP 429) as automation
        additionalTransactionInformation: false,
        includeRawTransaction: true,
        verbose: true,
        combineInstallments: false,
        showBrowser: process.env.SHOW_BROWSER !== '0',
        timeout: 120000, // 2 minutes for OTP
        defaultTimeout: 120000, // 2 minutes for navigation
        navigationRetryCount: 1,
        executablePath: findChromePath(),
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--safebrowsing-disable-auto-update',
          '--window-size=1920,1080',
        ],
        preparePage: async (page: Page) => {
          // The library closes the page before returning a failed result, so snapshot it on close
          const closePage = page.close.bind(page);
          page.close = async (...args: Parameters<Page['close']>) => {
            pageStateAtClose = await describePage(page);
            return closePage(...args);
          };

          // Use the real browser's user agent (minus "Headless") so it matches the
          // sec-ch-ua client hints; a hardcoded version mismatch trips bot detection
          const realUserAgent = await page.browser().userAgent();
          await page.setUserAgent(realUserAgent.replace('HeadlessChrome', 'Chrome'));

          // Remove webdriver property and other automation flags
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Override plugins
            Object.defineProperty(navigator, 'plugins', {
              get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
              ],
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
              get: () => ['he-IL', 'he', 'en-US', 'en'],
            });

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
              parameters.name === 'notifications'
                ? Promise.resolve({ state: 'denied' } as PermissionStatus)
                : originalQuery(parameters);
          });

          // Set extra HTTP headers
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
          });

          // Start OTP watcher in background for Hapoalim
          if (account.companyId === 'hapoalim') {
            const ask = hooks.requestOtp ? () => hooks.requestOtp!(account.companyId) : promptOtp;
            startOtpWatcher(page, ask).catch(() => {}); // Fire and forget
          }
        },
      });

      const result = await scraper.scrape(account.credentials as never);

      if (!result.success) {
        console.error(`Failed to scrape ${account.companyId}:`, result.errorType, result.errorMessage);
        if (pageStateAtClose) console.error(pageStateAtClose);
        recordScrapeRun(db, { company: account.companyId, startedAt, success: false,
          errorType: result.errorType, errorMessage: result.errorMessage });
        summaries.push({ company: account.companyId, success: false, newTransactionIds: [], errorType: result.errorType });
        hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
          errorType: result.errorType, errorMessage: result.errorMessage });
        continue;
      }

      const newIds: number[] = [];
      for (const acc of result.accounts ?? []) {
        const saved = saveScrapedAccount(db, account.companyId, acc);
        if (account.ownerMemberId) {
          db.prepare(`UPDATE accounts SET owner_member_id = ? WHERE id = ? AND owner_member_id IS NULL`).run(account.ownerMemberId, saved.accountId);
        }
        newIds.push(...saved.insertedIds);
        const label = acc.savingsAccount ? ' (savings deposit)' : '';
        console.log(`  ${saved.accountId}${label}: balance ${acc.balance ?? '-'} ${acc.currency ?? 'ILS'}, ${saved.insertedIds.length} new, ${saved.updated} updated`);
      }
      recordScrapeRun(db, { company: account.companyId, startedAt, success: true, newTransactions: newIds.length });
      summaries.push({ company: account.companyId, success: true, newTransactionIds: newIds });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: true, newTransactions: newIds.length });
    } catch (err) {
      console.error(`Error scraping ${account.companyId}:`, err);
      recordScrapeRun(db, { company: account.companyId, startedAt, success: false,
        errorType: 'EXCEPTION', errorMessage: String(err) });
      summaries.push({ company: account.companyId, success: false, newTransactionIds: [], errorType: 'EXCEPTION' });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
        errorType: 'EXCEPTION', errorMessage: err instanceof Error ? err.message : String(err) });
    }
  }
  return summaries;
}
