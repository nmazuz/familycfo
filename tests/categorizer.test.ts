import { afterEach, describe, expect, it, vi } from 'vitest';
import { categorize } from '../src/categorizer.js';
import { categorizeTransactions, findCategory, getOrCreateCategory } from '../src/ingest/classify.js';
import { addAccount, addTx, testDb } from './helpers.js';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([{ category: '"Parent > Child"' }, { text: 'Child.' }, { category: 'Child', text: 'Other' }])('extracts category from response %j', async body => {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body))); vi.stubGlobal('fetch', mock);
  expect(await categorize('Invented purchase', 'https://categorizer.invalid')).toBe('Child');
  expect(mock).toHaveBeenCalledWith('https://categorizer.invalid', expect.objectContaining({ method: 'POST', body: JSON.stringify({ description: 'Invented purchase' }), signal: expect.any(AbortSignal) }));
});
it.each(['empty', 'http', 'network', 'malformed'])('fails closed for %s response', async failure => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const mock = failure === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(failure === 'malformed' ? new Response('not json') : new Response(JSON.stringify({}), { status: failure === 'http' ? 503 : 200 }));
  vi.stubGlobal('fetch', mock); expect(await categorize('Test', 'https://categorizer.invalid')).toBeNull();
});
describe('classification category precedence', () => {
  it('manual description cache wins over scraper, and scraper alias wins over remote API', async () => {
    const db = testDb();
    try {
      addAccount(db, 'card:test', 'card');
      const manual = getOrCreateCategory(db, 'Manual'); const scraped = getOrCreateCategory(db, 'Scraped');
      db.prepare("INSERT INTO category_aliases (name, category_id) VALUES ('Old scraper name', ?)").run(scraped);
      const prior = addTx(db, { account: 'card:test', date: '2026-08-01', description: 'Same', amount: -10, categoryId: manual });
      db.prepare("UPDATE transactions SET category_source='manual' WHERE id=?").run(prior);
      const cached = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Same', amount: -10 });
      const other = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Other', amount: -20 });
      db.prepare("UPDATE transactions SET source_category='Old scraper name' WHERE id IN (?, ?)").run(cached, other);
      const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
      await categorizeTransactions(db, [cached, other, 999], 'https://categorizer.invalid');
      expect(db.prepare('SELECT category_id, category_source FROM transactions WHERE id=?').get(cached)).toEqual({ category_id: manual, category_source: 'cache' });
      expect(db.prepare('SELECT category_id, category_source FROM transactions WHERE id=?').get(other)).toEqual({ category_id: scraped, category_source: 'scraper' });
      expect(findCategory(db, 'Old scraper name')).toBe(scraped); expect(fetchMock).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it('ignores unknown remote categories rather than creating new categories', async () => {
    const db = testDb();
    try {
      addAccount(db, 'card:test', 'card'); const id = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Invented', amount: -10 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ category: 'Unknown' }))));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await categorizeTransactions(db, [id], 'https://categorizer.invalid');
      expect(db.prepare('SELECT category_id FROM transactions WHERE id=?').pluck().get(id)).toBeNull(); expect(db.prepare('SELECT COUNT(*) FROM categories').pluck().get()).toBe(0);
    } finally { db.close(); }
  });
});
