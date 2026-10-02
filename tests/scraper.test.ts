import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { testDb } from './helpers.js';
const { createScraper, scrape } = vi.hoisted(() => ({ createScraper: vi.fn(), scrape: vi.fn() }));
vi.mock('israeli-bank-scrapers', () => ({ CompanyTypes: { leumi: 'leumi', max: 'max' }, createScraper }));
import { scrapeAll, type Config } from '../src/scraper.js';
let db: DB;
const config: Config = { accounts: [{ companyId: 'leumi', credentials: { username: 'synthetic' } }, { companyId: 'max', credentials: { username: 'synthetic' } }] };
beforeEach(() => {
  db = testDb(); vi.clearAllMocks(); createScraper.mockReturnValue({ scrape });
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('scraper orchestration without real bank access', () => {
  it('persists successful account data and reports progress in order', async () => {
    vi.stubEnv('SCRAPE_ONLY', 'leumi');
    scrape.mockResolvedValue({ success: true, accounts: [{ accountNumber: 'SYNTHETIC', balance: 100,
      txns: [{ date: '2026-09-01T00:00:00Z', description: 'Invented shop', originalAmount: -10, chargedAmount: -10, originalCurrency: 'ILS', chargedCurrency: 'ILS', identifier: 'TEST', status: 'completed' }] }] });
    const progress = vi.fn(); const first = await scrapeAll(config, db, { onProgress: progress });
    expect(first).toEqual([{ company: 'leumi', success: true, newTransactionIds: [expect.any(Number)] }]);
    expect(progress.mock.calls.map(c => c[0].type)).toEqual(['start', 'done']);
    expect(db.prepare('SELECT balance FROM balances').pluck().get()).toBe(100);
    expect(db.prepare('SELECT success, new_transactions FROM scrape_runs').get()).toEqual({ success: 1, new_transactions: 1 });
    expect((await scrapeAll(config, db))[0].newTransactionIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
  });
  it('continues after a failed bank and after an exception, recording both failures', async () => {
    scrape.mockResolvedValueOnce({ success: false, errorType: 'LOGIN', errorMessage: 'synthetic failure' }).mockRejectedValueOnce(new Error('synthetic exception'));
    const progress = vi.fn(); const result = await scrapeAll(config, db, { onProgress: progress });
    expect(result).toEqual([{ company: 'leumi', success: false, newTransactionIds: [], errorType: 'LOGIN' }, { company: 'max', success: false, newTransactionIds: [], errorType: 'EXCEPTION' }]);
    expect(db.prepare('SELECT success FROM scrape_runs').pluck().all()).toEqual([0, 0]);
    expect(progress.mock.calls.map(c => c[0].type)).toEqual(['start', 'done', 'start', 'done']);
  });
  it('rejects an invalid backfill date before making a scraper', async () => {
    vi.stubEnv('SCRAPE_FROM', 'invalid'); await expect(scrapeAll(config, db)).rejects.toThrow('SCRAPE_FROM'); expect(createScraper).not.toHaveBeenCalled();
  });
  it('passes backfill/headless options and future separate installments to the adapter', async () => {
    vi.stubEnv('SCRAPE_FROM', '2026-01-01'); vi.stubEnv('SHOW_BROWSER', '0'); vi.stubEnv('SCRAPE_ONLY', ' leumi , ');
    scrape.mockResolvedValue({ success: true }); await scrapeAll(config, db);
    expect(createScraper).toHaveBeenCalledOnce(); expect(createScraper.mock.calls[0][0]).toMatchObject({ companyId: 'leumi', showBrowser: false, futureMonthsToScrape: 2, combineInstallments: false, includeRawTransaction: true });
    expect(createScraper.mock.calls[0][0].startDate.getFullYear()).toBe(2026);
    expect(createScraper.mock.calls[0][0].startDate.getMonth()).toBe(0);
  });
  it('empty account lists do not touch the DB', async () => {
    expect(await scrapeAll({ accounts: [] }, db)).toEqual([]); expect(createScraper).not.toHaveBeenCalled(); expect(db.prepare('SELECT COUNT(*) FROM scrape_runs').pluck().get()).toBe(0);
  });
});
