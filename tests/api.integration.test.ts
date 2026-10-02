import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { categoryRoutes } from '../src/server/routes/categories.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { eventRoutes } from '../src/server/routes/events.js';
import { pensionRoutes } from '../src/server/routes/pension.js';
import { investmentRoutes } from '../src/server/routes/investments.js';
import { registerCrud, camel, snake, pickColumns, toApi } from '../src/server/crud.js';
import { loadTransactions } from '../src/analytics/common.js';
import { addAccount, addTx, testDb } from './helpers.js';

let db: DB;
let app: FastifyInstance;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in isolated API test'); }));
  db = testDb(); app = Fastify();
  categoryRoutes(app, db); transactionRoutes(app, db); eventRoutes(app, db); pensionRoutes(app, db); investmentRoutes(app, db);
  registerCrud(app, db, { table: 'tags', path: 'tags', columns: ['name', 'budget', 'notes', 'startDate', 'endDate'] });
  registerCrud(app, db, { table: 'members', path: 'members', columns: ['name', 'color'], allowDelete: false });
  registerCrud(app, db, { table: 'accounts', path: 'accounts', columns: ['displayName'], idType: 'text', allowCreate: false, allowDelete: false });
  addAccount(db, 'bank:test', 'bank'); addAccount(db, 'card:test', 'card');
});
afterEach(async () => { await app.close(); db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, payload });
async function category(name: string, extra: object = {}) {
  const r = await post('/api/categories', { name, ...extra }); expect(r.statusCode).toBe(200); return r.json().id as number;
}

describe('CRUD serialization and allowed fields', () => {
  it('maps only explicit camelCase fields and preserves zero, false and null', () => {
    expect(snake('ownerMemberId')).toBe('owner_member_id'); expect(camel('owner_member_id')).toBe('ownerMemberId');
    expect(pickColumns({ ownerMemberId: 0, notes: '', archived: false, budget: null, id: 99 }, ['owner_member_id', 'notes', 'archived', 'budget']))
      .toEqual({ owner_member_id: 0, notes: null, archived: false, budget: null });
    expect(toApi({ owner_member_id: 1, name: 'Test' })).toEqual({ ownerMemberId: 1, name: 'Test' });
  });
  it('creates, lists, edits and deletes a tag without allowing arbitrary columns', async () => {
    const r = await post('/api/tags', { name: 'Invented event', budget: 100, notes: '', id: 999, startDate: '2026-09-01' });
    expect(r.statusCode).toBe(200); const tag = r.json();
    expect(tag).toMatchObject({ name: 'Invented event', budget: 100, notes: null, startDate: '2026-09-01' }); expect(tag.id).not.toBe(999);
    expect((await patch(`/api/tags/${tag.id}`, { budget: 0 })).json().budget).toBe(0);
    expect((await app.inject('/api/tags')).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${tag.id}` })).json()).toEqual({ ok: true });
    expect((await app.inject('/api/tags')).json()).toEqual([]);
  });
  it('returns 400 for empty allowed edits and 404 for missing rows', async () => {
    expect((await post('/api/tags', { ignored: true })).statusCode).toBe(400);
    expect((await patch('/api/tags/999', { name: 'Missing' })).statusCode).toBe(404);
    expect((await patch('/api/tags/999', {})).statusCode).toBe(400);
  });
  it('updates text account identifiers and does not register disabled operations', async () => {
    expect((await patch('/api/accounts/bank%3Atest', { displayName: 'Renamed' })).json().displayName).toBe('Renamed');
    expect((await post('/api/accounts', { name: 'Invalid' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/members/1' })).statusCode).toBe(404);
  });
});

describe('category tree, rename and merge transactions', () => {
  it('inherits parent flags and rejects a third level, self-parent and a root-with-children becoming a child', async () => {
    const root = await category('Root', { kind: 'income', defaultFixed: 1, discretionary: 0 });
    const childResponse = await post('/api/categories', { name: 'Child', parentId: root });
    expect(childResponse.json()).toMatchObject({ parentId: root, kind: 'income', defaultFixed: 1, discretionary: 0 });
    const child = childResponse.json().id; const other = await category('Other');
    expect((await post('/api/categories', { name: 'Third', parentId: child })).statusCode).toBe(400);
    expect((await patch(`/api/categories/${root}`, { parentId: root })).statusCode).toBe(400);
    expect((await patch(`/api/categories/${root}`, { parentId: other })).statusCode).toBe(400);
    expect((await post('/api/categories', { name: 'Missing parent', parentId: 999 })).statusCode).toBe(400);
  });
  it('trims names, rejects duplicates and invalid updates, and creates a rename alias', async () => {
    const id = await category('  Old  '); const other = await category('Other');
    expect((await post('/api/categories', { name: 'Old' })).statusCode).toBe(409);
    expect((await post('/api/categories', { name: ' ' })).statusCode).toBe(400);
    expect((await patch(`/api/categories/${id}`, { name: 'Other' })).statusCode).toBe(409);
    expect((await patch(`/api/categories/${id}`, { kind: 'invalid' })).statusCode).toBe(400);
    expect((await patch('/api/categories/999', { name: 'Missing' })).statusCode).toBe(404);
    expect((await patch(`/api/categories/${id}`, { name: 'New', parentId: other })).json()).toMatchObject({ name: 'New', parentId: other });
    expect(db.prepare("SELECT category_id FROM category_aliases WHERE name='Old'").pluck().get()).toBe(id);
  });
  it('merges usage, budgets, rules and aliases atomically and promotes children', async () => {
    const from = await category('From'); const to = await category('To'); const child = await category('Child', { parentId: from });
    const tx = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Invented', amount: -50, kind: 'expense', categoryId: from });
    db.prepare("UPDATE transactions SET category_source='manual' WHERE id=?").run(tx);
    db.prepare("INSERT INTO budgets (category_id, monthly_amount, effective_from) VALUES (?, 100, '2026-09'), (?, 200, '2026-09')").run(from, to);
    db.prepare("INSERT INTO category_rules (match_type, pattern, set_category_id) VALUES ('contains', 'invented', ?)").run(from);
    db.prepare("INSERT INTO category_aliases (name, category_id) VALUES ('Alias', ?)").run(from);
    const r = await app.inject({ method: 'DELETE', url: `/api/categories/${from}?moveTo=${to}` });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ ok: true, moved: 1 });
    expect(db.prepare('SELECT category_id, category_source FROM transactions WHERE id=?').get(tx)).toEqual({ category_id: to, category_source: 'manual' });
    expect(db.prepare('SELECT monthly_amount FROM budgets').pluck().all()).toEqual([300]);
    expect(db.prepare('SELECT parent_id FROM categories WHERE id=?').pluck().get(child)).toBeNull();
    expect(db.prepare('SELECT set_category_id FROM category_rules').pluck().get()).toBe(to);
    expect(db.prepare('SELECT category_id FROM category_aliases').pluck().all()).toEqual([to, to]);
    expect((await app.inject('/api/categories')).json().find((c: { id: number }) => c.id === to)).toMatchObject({ transactions: 1, total: -50 });
  });
  it('deletes without merge into uncategorized, removing budgets and aliases', async () => {
    const id = await category('Remove'); const tx = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Test', amount: -10, categoryId: id });
    db.prepare("UPDATE transactions SET category_source='manual' WHERE id=?").run(tx);
    db.prepare("INSERT INTO budgets (category_id, monthly_amount, effective_from) VALUES (?, 100, '2026-09')").run(id);
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${id}` })).statusCode).toBe(200);
    expect(db.prepare('SELECT category_id, category_source FROM transactions WHERE id=?').get(tx)).toEqual({ category_id: null, category_source: null });
    expect(db.prepare('SELECT COUNT(*) FROM budgets').pluck().get()).toBe(0);
  });
  it('invalid merges leave all data unchanged', async () => {
    const id = await category('Keep');
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${id}?moveTo=${id}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${id}?moveTo=999` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/categories/999' })).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) FROM categories').pluck().get()).toBe(1);
  });
});

describe('transaction workflows and totals', () => {
  it('manual creation, replacement and deletion preserve signed household totals', async () => {
    const r = await post('/api/transactions/manual', { date: '2026-09-01', description: 'Cash purchase', amount: 123, kind: 'expense' });
    expect(r.statusCode).toBe(200); const id = r.json().id;
    expect(r.json()).toMatchObject({ amount: -123, accountKind: 'manual', date: '2026-09-01' });
    const updated = await app.inject({ method: 'PUT', url: `/api/transactions/${id}/manual`, payload: { date: '2026-09-02', description: 'Cash income', amount: 80, kind: 'income' } });
    expect(updated.statusCode).toBe(200); expect(updated.json()).toMatchObject({ amount: 80, kind: 'income', description: 'Cash income' });
    expect((await app.inject('/api/transactions?cycle=2026-09')).json().totals).toMatchObject({ income: 80, spend: 0 });
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${id}` })).statusCode).toBe(200);
    expect(loadTransactions(db)).toEqual([]);
  });
  it.each([{ date: 'bad', description: 'Test', amount: 1 }, { date: '2026-09-01', description: ' ', amount: 1 }, { date: '2026-09-01', description: 'Test', amount: 0 }])('rejects incomplete manual input', async payload => {
    expect((await post('/api/transactions/manual', payload)).statusCode).toBe(400);
    expect(loadTransactions(db)).toEqual([]);
  });
  it('does not allow full replacement or deletion of a scraped transaction', async () => {
    const id = addTx(db, { account: 'bank:test', date: '2026-09-01', description: 'Bank purchase', amount: -100, kind: 'expense' });
    expect((await app.inject({ method: 'PUT', url: `/api/transactions/${id}/manual`, payload: { date: '2026-09-02', description: 'Changed', amount: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${id}` })).statusCode).toBe(400);
    expect(loadTransactions(db)[0].amount).toBe(-100);
  });
  it('pagination changes rows but not aggregate totals; excluded rows do not count', async () => {
    const ids = [100, 200, 300].map(amount => addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Shop', amount: -amount, kind: 'expense' }));
    await patch(`/api/transactions/${ids[2]}`, { excluded: 1 });
    const r = (await app.inject('/api/transactions?limit=1&offset=1&kind=expense')).json();
    expect(r.total).toBe(3); expect(r.rows).toHaveLength(1); expect(r.rows[0].id).toBe(ids[1]); expect(r.totals.spend).toBe(300);
    expect((await app.inject('/api/transactions?search=unmatched')).json().total).toBe(0);
  });
  it('confirmed paybacks reduce expense and do not count twice as income', async () => {
    const e = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Dinner', amount: -300, kind: 'expense' });
    const i = addTx(db, { account: 'bank:test', date: '2026-09-02', description: 'Bit', amount: 100, kind: 'income' });
    expect((await post('/api/links', { fromTxnId: i, toTxnId: e })).statusCode).toBe(200);
    expect((await app.inject('/api/transactions')).json().totals).toMatchObject({ spend: 200, income: 0 });
    const links = (await app.inject('/api/links?status=confirmed')).json(); expect(links).toHaveLength(1);
    await patch(`/api/links/${links[0].id}`, { status: 'rejected' });
    expect((await app.inject('/api/transactions')).json().totals).toMatchObject({ spend: 300, income: 100 });
  });
  it('bulk updates roll back earlier rows on an invalid tag foreign key', async () => {
    const ids = [1, 2].map(n => addTx(db, { account: 'card:test', date: '2026-09-01', description: `Shop ${n}`, amount: -10, kind: 'expense' }));
    const r = await post('/api/transactions/bulk', { ids, patch: { notes: 'Should roll back', tagIds: [999] } });
    expect(r.statusCode).toBe(500);
    expect(db.prepare('SELECT notes FROM transactions').pluck().all()).toEqual([null, null]);
  });
  it('rules apply to matching rows but preserve manually set category and kind', async () => {
    const categoryId = await category('Auto'); const manualCategory = await category('Manual');
    const a = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'SHOP X123', amount: -100, kind: 'expense' });
    const b = addTx(db, { account: 'card:test', date: '2026-09-02', description: 'SHOP Y456', amount: -100, kind: 'expense' });
    await patch(`/api/transactions/${a}`, { categoryId: manualCategory, kind: 'savings' });
    expect((await app.inject(`/api/transactions/${a}/similar`)).json()).toMatchObject({ count: 1, ids: [b] });
    const rule = (await post('/api/rules', { fromTransactionId: a, setCategoryId: categoryId, setKind: 'expense' })).json();
    expect(rule.applied).toBe(2);
    expect(loadTransactions(db).find(t => t.id === a)).toMatchObject({ categoryId: manualCategory, kind: 'savings' });
    expect(loadTransactions(db).find(t => t.id === b)).toMatchObject({ categoryId, kind: 'expense' });
    expect((await app.inject('/api/rules')).json()).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/rules/${rule.id}` }); expect((await app.inject('/api/rules')).json()).toEqual([]);
  });
  it('planned expense matches a unique actual row then undo rejects that row', async () => {
    const tx = addTx(db, { account: 'card:test', date: '2026-09-03', description: 'Appliance', amount: -500, kind: 'expense' });
    const p = await post('/api/planned', { date: '2026-09-01', description: 'Appliance', amount: 500, accountId: 'card:test' });
    expect(p.statusCode).toBe(200); expect(p.json().matched).toBe(true);
    const id = p.json().id;
    expect((await app.inject('/api/planned?status=matched')).json()[0]).toMatchObject({ id, matchedTxnId: tx });
    await patch(`/api/planned/${id}`, { status: 'planned' });
    const reopened = (await app.inject('/api/planned')).json()[0];
    expect(reopened).toMatchObject({ status: 'planned', matchedTxnId: null, candidates: [] });
    await patch(`/api/planned/${id}`, { status: 'cancelled' });
    expect((await app.inject('/api/planned')).json()).toEqual([]);
    await app.inject({ method: 'DELETE', url: `/api/planned/${id}` });
    expect(db.prepare('SELECT COUNT(*) FROM planned_items').pluck().get()).toBe(0);
  });
});

describe('event tagging', () => {
  it('tags idempotently, nets refunds, excludes transfers and returns foreign candidates first', async () => {
    const tag = (await post('/api/tags', { name: 'Invented holiday', startDate: '2026-09-01', endDate: '2026-09-10' })).json().id;
    const e = addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Hotel', amount: -500, currency: 'EUR', kind: 'expense' });
    const r = addTx(db, { account: 'card:test', date: '2026-09-02', description: 'Hotel', amount: 100, currency: 'EUR', kind: 'refund' });
    const t = addTx(db, { account: 'bank:test', date: '2026-09-03', description: 'Transfer', amount: -1000, kind: 'transfer' });
    const foreign = addTx(db, { account: 'card:test', date: '2026-09-05', description: 'Foreign', amount: -20, currency: 'USD', kind: 'expense' });
    const local = addTx(db, { account: 'card:test', date: '2026-09-04', description: 'Local', amount: -20, kind: 'expense' });
    await post(`/api/events/${tag}/transactions`, { add: [e, r, t] }); await post(`/api/events/${tag}/transactions`, { add: [e] });
    const detail = (await app.inject(`/api/events/${tag}`)).json();
    expect(detail).toMatchObject({ total: 400, spend: 500, refunds: 100, count: 2, byCurrency: [{ currency: 'EUR', original: 400, ils: 400, count: 2 }] });
    expect((await app.inject('/api/events')).json()[0]).toMatchObject({ total: 400, count: 2 });
    expect((await app.inject(`/api/events/${tag}/candidates`)).json().rows.map((row: { id: number }) => row.id)).toEqual([foreign, local]);
    await post(`/api/events/${tag}/transactions`, { remove: [r] });
    expect((await app.inject(`/api/events/${tag}`)).json().total).toBe(500);
  });
  it('returns 404 for missing event and no candidates without dates', async () => {
    expect((await app.inject('/api/events/999')).statusCode).toBe(404);
    expect((await app.inject('/api/events/999/candidates')).statusCode).toBe(404);
    const id = (await post('/api/tags', { name: 'Undated' })).json().id;
    expect((await app.inject(`/api/events/${id}/candidates`)).json().rows).toEqual([]);
  });
});

describe('manual investment API', () => {
  it('creates with a baseline, updates without changing symbol, and deletes offline', async () => {
    const r = await post('/api/investments/holdings', { symbol: ' invented ', quantity: 2, manualPrice: 10, currency: 'ILS' });
    expect(r.statusCode).toBe(200); const id = r.json().id;
    expect(r.json()).toMatchObject({ symbol: 'INVENTED', baselinePrice: 10, baselineDate: '2026-09-15', manualPriceDate: '2026-09-15' });
    const updated = await patch(`/api/investments/holdings/${id}`, { symbol: 'OTHER', manualPrice: 12 });
    expect(updated.json()).toMatchObject({ symbol: 'INVENTED', manualPrice: 12, manualPriceDate: '2026-09-15' });
    expect((await patch(`/api/investments/holdings/${id}`, { symbol: 'OTHER' })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: `/api/investments/holdings/${id}` });
    expect(db.prepare('SELECT COUNT(*) FROM holdings').pluck().get()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing symbols, invalid quantities and missing records', async () => {
    expect((await post('/api/investments/holdings', { quantity: 1, manualPrice: 10 })).statusCode).toBe(400);
    expect((await post('/api/investments/holdings', { symbol: 'TEST', quantity: 0, manualPrice: 10 })).statusCode).toBe(400);
    expect((await patch('/api/investments/holdings/999', { quantity: 1 })).statusCode).toBe(404);
    expect((await app.inject('/api/investments/quote')).statusCode).toBe(400);
    expect((await app.inject('/api/investments/search?q=שלום')).json()).toEqual([]);
  });
});
