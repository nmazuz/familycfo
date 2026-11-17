import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { addAccount, addTx, testDb } from './helpers.js';
import { saveTransactions } from '../src/db/ingestRepo.js';
import { normalizeTransactions } from '../src/ingest/normalize.js';
import { categorizeTransactions } from '../src/ingest/classify.js';

function setup() {
  const db = testDb();
  addAccount(db, 'max:1', 'card');
  const app = Fastify();
  transactionRoutes(app, db);
  return { db, app };
}

describe('transaction follow-up and zero amounts', () => {
  it('hides zero amounts by default, with an explicit opt-in, and totals match the visible rows', async () => {
    const { db, app } = setup();
    addTx(db, { account: 'max:1', date: '2026-09-01', description: 'ממתין', amount: 0, status: 'pending' });
    const paid = addTx(db, { account: 'max:1', date: '2026-09-01', description: 'קנייה', amount: -100, kind: 'expense' });
    const result = (await app.inject('/api/transactions')).json();
    expect(result.rows.map((r: any) => r.id)).toEqual([paid]);
    expect(result.totals.spend).toBe(100);
    expect((await app.inject('/api/transactions?showZero=1')).json().total).toBe(2);
  });

  it('supports follow-up for single and bulk edits, separately from category review', async () => {
    const { db, app } = setup();
    const a = addTx(db, { account: 'max:1', date: '2026-09-01', description: 'a', amount: -20 });
    const b = addTx(db, { account: 'max:1', date: '2026-10-01', description: 'b', amount: -30 });
    const patch = await app.inject({ method: 'PATCH', url: `/api/transactions/${a}`, payload: { followUp: true, notes: 'לברר החזר' } });
    expect(patch.json()).toMatchObject({ followUp: true, notes: 'לברר החזר' });
    expect((await app.inject('/api/transactions?followUp=1')).json().rows.map((r: any) => r.id)).toEqual([a]);
    await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [a, b], patch: { followUp: 1 } } });
    expect((await app.inject('/api/transactions?followUp=1')).json().total).toBe(2);
    await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [a, b], patch: { followUp: 0 } } });
    expect((await app.inject('/api/transactions?followUp=1')).json().total).toBe(0);
    expect((await app.inject({ method: 'PATCH', url: `/api/transactions/${a}`, payload: { followUp: 'yes' } })).statusCode).toBe(400);
  });

  it('filters precisely by a persisted scrape batch, including an empty latest batch', async () => {
    const { db, app } = setup();
    const a = addTx(db, { account: 'max:1', date: '2026-08-01', description: 'old', amount: -10 });
    const b = addTx(db, { account: 'max:1', date: '2026-09-01', description: 'new', amount: -20 });
    const batch = Number(db.prepare('INSERT INTO scrape_batches DEFAULT VALUES').run().lastInsertRowid);
    db.prepare('UPDATE transactions SET scrape_batch_id = ? WHERE id = ?').run(batch, b);
    expect((await app.inject(`/api/transactions?scrapeBatch=${batch}`)).json().rows.map((r: any) => r.id)).toEqual([b]);
    db.prepare('INSERT INTO scrape_batches DEFAULT VALUES').run();
    expect((await app.inject('/api/transactions?scrapeBatch=latest')).json().total).toBe(0);
    expect((await app.inject(`/api/transactions?scrapeBatch=${batch}`)).json().total).toBe(1);
    expect((await app.inject('/api/transactions')).json().rows.map((r: any) => r.id)).toContain(a);
  });

  it('preserves an explicitly uncategorized manual choice when updated rows are classified', async () => {
    const { db } = setup();
    const a = addTx(db, { account: 'max:1', date: '2026-09-01', description: 'shop', amount: -10 });
    const category = Number(db.prepare("INSERT INTO categories (name) VALUES ('סופר')").run().lastInsertRowid);
    addTx(db, { account: 'max:1', date: '2026-09-02', description: 'shop', amount: -20, categoryId: category });
    db.prepare("UPDATE transactions SET category_source = 'manual' WHERE id = ?").run(a);
    await categorizeTransactions(db, [a]);
    expect(db.prepare('SELECT category_id FROM transactions WHERE id = ?').pluck().get(a)).toBeNull();
  });
});

const row = (extra: Record<string, unknown> = {}) => ({
  type: 'normal', status: 'pending', date: '2026-09-01T21:00:00Z', description: 'חנות',
  originalCurrency: 'ILS', originalAmount: 0, chargedAmount: 0, ...extra,
});
const normalized = (rows: ReturnType<typeof row>[]) => normalizeTransactions('max:1', rows as any);

describe('completed pending transactions', () => {
  it('uses a stable reference when bank fields change and preserves user fields and first scrape batch', () => {
    const { db } = setup();
    const batch = Number(db.prepare('INSERT INTO scrape_batches DEFAULT VALUES').run().lastInsertRowid);
    const id = saveTransactions(db, normalized([row({ identifier: 'ref' })])).insertedIds[0];
    db.prepare("UPDATE transactions SET follow_up = 1, notes = 'החזר', kind = 'refund', kind_source = 'manual', category_source = 'manual', member_id = 2, scrape_batch_id = ? WHERE id = ?").run(batch, id);
    const result = saveTransactions(db, normalized([row({ identifier: 'ref', status: 'completed', description: 'חנות בעמ',
      date: '2026-09-02T21:00:00Z', processedDate: '2026-10-01T21:00:00Z', originalAmount: -12, originalCurrency: 'USD',
      chargedAmount: -42, chargedCurrency: 'ILS', memo: 'bank memo', category: 'קניות', rawTransaction: { settled: true } })]));
    expect(result).toMatchObject({ insertedIds: [], updatedIds: [id], updated: 1 });
    expect(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id)).toMatchObject({
      status: 'completed', description: 'חנות בעמ', original_amount: -12, original_currency: 'USD', charged_amount: -42,
      processed_date: '2026-10-01T21:00:00Z', memo: 'bank memo', source_category: 'קניות', raw_json: '{"settled":true}',
      follow_up: 1, notes: 'החזר', kind: 'refund', kind_source: 'manual', member_id: 2, scrape_batch_id: batch,
    });
  });

  it('replaces a unique zero placeholder without a reference and remains idempotent', () => {
    const { db } = setup();
    const id = saveTransactions(db, normalized([row()])).insertedIds[0];
    const completed = normalized([row({ status: 'completed', originalAmount: -30, chargedAmount: -30 })]);
    expect(saveTransactions(db, completed)).toMatchObject({ insertedIds: [], updatedIds: [id] });
    expect(saveTransactions(db, completed).insertedIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
  });

  it('keeps two identical pending purchases as two completed rows', () => {
    const { db } = setup();
    const pending = row({ originalAmount: -20 });
    saveTransactions(db, normalized([pending, pending]));
    const result = saveTransactions(db, normalized(['a', 'b'].map(identifier => row({ identifier, status: 'completed', originalAmount: -20, chargedAmount: -20 }))));
    expect(result.insertedIds).toEqual([]);
    expect(new Set(result.updatedIds).size).toBe(2);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(2);
  });

  it('does not revert a settled row when the bank still returns a stale pending copy', () => {
    const { db } = setup();
    const completed = row({ identifier: 'stable', status: 'completed', originalAmount: -20, chargedAmount: -20 });
    const id = saveTransactions(db, normalized([completed])).insertedIds[0];
    saveTransactions(db, normalized([{ ...completed, status: 'pending', chargedAmount: 0 }]));
    expect(db.prepare('SELECT status, charged_amount FROM transactions WHERE id = ?').get(id)).toEqual({ status: 'completed', charged_amount: -20 });
  });

  it('does not guess when two zero placeholders could be different purchases', () => {
    const { db } = setup();
    saveTransactions(db, normalized([row(), row()]));
    const result = saveTransactions(db, normalized([row({ identifier: 'new', status: 'completed', originalAmount: -20, chargedAmount: -20 })]));
    expect(result.insertedIds).toHaveLength(1);
    expect(result.updated).toBe(0);
  });
});
