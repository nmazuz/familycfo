import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './helpers.js';
import { scrapeAll, type Config } from '../src/scraper.js';

const mocks = vi.hoisted(() => ({ scrape: vi.fn() }));
vi.mock('israeli-bank-scrapers', () => ({ CompanyTypes: { max: 'max' }, createScraper: () => ({ scrape: mocks.scrape }) }));
vi.mock('../src/browser.js', () => ({ findBrowser: async () => ({ path: '/fake-browser' }), NO_BROWSER: 'missing browser' }));

const config: Config = { accounts: [{ companyId: 'max', credentials: {} }] };
const response = (amount = -40, status = 'completed') => ({ success: true, accounts: [{ accountNumber: 'test', balance: 0, txns: [{
  identifier: 'ref', type: 'normal', date: '2026-11-01T12:00:00Z', description: 'synthetic shop',
  originalAmount: -40, originalCurrency: 'ILS', chargedAmount: amount, status,
}] }] });
beforeEach(() => mocks.scrape.mockReset());

describe('persisted scrape batches', () => {
  it('records only insertions as new, and preserves first-seen membership on a pending completion', async () => {
    const db = testDb();
    mocks.scrape.mockResolvedValueOnce(response(0, 'pending')).mockResolvedValueOnce(response());
    const first = await scrapeAll(config, db, { showBrowser: false });
    const id = first[0].newTransactionIds[0];
    const batch = db.prepare('SELECT scrape_batch_id FROM transactions WHERE id = ?').pluck().get(id);
    expect(batch).toBe(1);
    const second = await scrapeAll(config, db, { showBrowser: false });
    expect(second[0].newTransactionIds).toEqual([]);
    expect(second[0].updatedTransactionIds).toEqual([id]);
    expect(db.prepare('SELECT scrape_batch_id, status, charged_amount FROM transactions WHERE id = ?').get(id)).toEqual({ scrape_batch_id: 1, status: 'completed', charged_amount: -40 });
    expect(db.prepare('SELECT COUNT(*) FROM transactions WHERE scrape_batch_id = 2').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM scrape_batches WHERE finished_at IS NOT NULL').pluck().get()).toBe(2);
  });

  it('records an empty failed run without falling back to a previous successful batch', async () => {
    const db = testDb();
    mocks.scrape.mockResolvedValueOnce(response()).mockResolvedValueOnce({ success: false, errorType: 'Timeout' });
    await scrapeAll(config, db);
    await scrapeAll(config, db);
    expect(db.prepare('SELECT MAX(id) FROM scrape_batches').pluck().get()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) FROM transactions WHERE scrape_batch_id = 2').pluck().get()).toBe(0);
  });

  it('reports rows already saved if a later account fails to ingest', async () => {
    const db = testDb();
    const result = response();
    result.accounts.push({ ...result.accounts[0], accountNumber: 'invalid', txns: [{ ...result.accounts[0].txns[0], originalAmount: null as any }] });
    mocks.scrape.mockResolvedValue(result);
    const [summary] = await scrapeAll(config, db);
    expect(summary.success).toBe(false);
    expect(summary.newTransactionIds).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) FROM transactions WHERE scrape_batch_id = 1').pluck().get()).toBe(1);
    expect(db.prepare('SELECT new_transactions FROM scrape_runs').pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM accounts WHERE id = 'max:invalid'").pluck().get()).toBe(0);
  });

  it('does not create batches or rows while checking a login', async () => {
    const db = testDb();
    mocks.scrape.mockResolvedValue(response());
    await scrapeAll(config, db, {}, { checkOnly: true });
    expect(db.prepare('SELECT COUNT(*) FROM scrape_batches').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(0);
  });
});
