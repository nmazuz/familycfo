import type { DB } from '../db/connection.js';
import { scrapeAll } from '../scraper.js';
import { runPipeline } from '../pipeline.js';
// reads the bank credentials file; the credentials go only to the scraper and are never returned by the API
import { loadConfig } from '../config.js';
import { emitAppEvent } from './appEvents.js';
import { findBrowser, NO_BROWSER } from '../browser.js';

/**
 * One scrape at a time, started from the UI: all banks, then the pipeline. The bank's OTP screen
 * becomes a pending request that the UI answers (POST /api/scrape/otp). State lives in memory —
 * a server restart (tsx watch) ends a running scrape.
 */
export interface ScrapeCompanyState {
  company: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  newTransactions: number;
  error: string | null;
}
export interface ScrapeJobState {
  /** check = the desktop app checks a login it just saved: log in only, nothing saved */
  mode: 'scrape' | 'check';
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  companies: ScrapeCompanyState[];
  /** the bank is waiting for an OTP code */
  otp: { company: string; requestedAt: string } | null;
  newTransactions: number;
  error: string | null;
}

const idle = (): ScrapeJobState => ({ mode: 'scrape', status: 'idle', startedAt: null, finishedAt: null, companies: [], otp: null, newTransactions: 0, error: null });
let state: ScrapeJobState = idle();
let answerOtp: ((code: string) => void) | null = null;

export const scrapeState = (): ScrapeJobState => state;
export const scrapeRunning = () => state.status === 'running' || state.status === 'pipeline';

const clearOtp = () => {
  answerOtp?.('');
  answerOtp = null;
  state.otp = null;
};

const setCompany = (company: string, patch: Partial<ScrapeCompanyState>) => {
  state.companies = state.companies.map(c => (c.company === company ? { ...c, ...patch } : c));
};

export interface StartOptions { loginIds?: string[]; checkOnly?: boolean; showBrowser?: boolean }

export async function startScrape(db: DB, opts: StartOptions = {}): Promise<ScrapeJobState> {
  if (scrapeRunning()) throw Object.assign(new Error('a scrape is already running'), { statusCode: 409 });
  // before the logins are decrypted: without a browser there is nothing to use them for
  if (!(await findBrowser())) throw Object.assign(new Error(NO_BROWSER), { statusCode: 400 });
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(opts.loginIds);
  } catch {
    throw Object.assign(new Error('the bank logins are missing or invalid (accounts.json, or the desktop app\'s bank accounts)'), { statusCode: 400 });
  }
  // checked again: another start may have come in while the logins were read
  if (scrapeRunning()) throw Object.assign(new Error('a scrape is already running'), { statusCode: 409 });
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  state = {
    ...idle(), mode: opts.checkOnly ? 'check' : 'scrape', status: 'running', startedAt: new Date().toISOString(),
    companies: config.accounts.filter(a => !only || only.includes(a.companyId))
      .map(a => ({ company: a.companyId, status: 'pending', newTransactions: 0, error: null })),
  };
  emitAppEvent({ type: 'scrape-start', mode: state.mode });
  const categoryApiUrl = config.categoryApiUrl
    || (db.prepare(`SELECT value FROM settings WHERE key = 'category_api_url'`).pluck().get() as string | undefined) || undefined;

  (async () => {
    const results = await scrapeAll(config, db, {
      showBrowser: opts.showBrowser,
      requestOtp: company => new Promise<string>(resolve => {
        answerOtp = resolve;
        state.otp = { company, requestedAt: new Date().toISOString() };
        emitAppEvent({ type: 'otp', company });
      }),
      onProgress: event => {
        if (event.type === 'start') setCompany(event.company, { status: 'running' });
        else {
          // a bank that ended (e.g. timed out) no longer needs its code
          if (state.otp?.company === event.company) clearOtp();
          setCompany(event.company, event.success
            ? { status: 'done', newTransactions: event.newTransactions }
            : { status: 'failed', error: event.errorMessage || event.errorType || 'error' });
        }
      },
    }, { checkOnly: opts.checkOnly });
    if (opts.checkOnly) {
      state.status = results.every(r => r.success) ? 'done' : 'failed';
      return;
    }
    state.status = 'pipeline';
    const newIds = results.flatMap(r => r.newTransactionIds);
    state.newTransactions = newIds.length;
    await runPipeline(db, { txIds: newIds, categoryApiUrl });
    state.status = results.some(r => r.success) ? 'done' : 'failed';
    if (state.status === 'failed') state.error = 'no bank was scraped';
  })().catch(err => {
    console.error('Scrape job failed:', err);
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
  }).finally(() => {
    clearOtp();
    state.finishedAt = new Date().toISOString();
    emitAppEvent({
      type: 'scrape-end', mode: state.mode, status: state.status === 'done' ? 'done' : 'failed', newTransactions: state.newTransactions,
      failed: state.companies.filter(c => c.status === 'failed').map(c => c.company), error: state.error,
    });
  });

  return state;
}

/** The code the user typed for the bank's OTP screen. */
export function submitOtp(code: string): void {
  if (!answerOtp) throw Object.assign(new Error('no bank is waiting for a code'), { statusCode: 409 });
  if (!/^\d{4,8}$/.test(code)) throw Object.assign(new Error('the code must be 4–8 digits'), { statusCode: 400 });
  const resolve = answerOtp;
  answerOtp = null;
  state.otp = null;
  resolve(code);
}
