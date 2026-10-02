import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { analyticsRoutes } from '../src/server/routes/analytics.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';
let db: DB; let app: FastifyInstance;
beforeEach(() => {
  db = testDb(); app = Fastify(); analyticsRoutes(app, db);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  addAccount(db, 'bank:test', 'bank'); addBalance(db, 'bank:test', 1000);
});
afterEach(async () => { await app.close(); db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('analytics HTTP contracts', () => {
  it.each(['/summary', '/income', '/cashflow', '/forecast?days=5', '/cards/upcoming', '/month-plan', '/installments', '/recurring', '/budgets', '/planning', '/alerts', '/recommendations', '/sync-status', '/scrape'])('serves a migrated empty household at %s offline', async path => {
    const response = await app.inject(`/api${path}`); expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('application/json'); expect(response.json()).toBeDefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it('budget replacement does not duplicate null-member household budgets, and clearing preserves past budgets', async () => {
    const id = Number(db.prepare("INSERT INTO categories (name) VALUES ('Invented')").run().lastInsertRowid);
    for (const [effectiveFrom, monthlyAmount] of [['2026-08', 100], ['2026-09', 200], ['2026-09', 300]] as const) {
      const response = await app.inject({ method: 'PUT', url: '/api/budgets', payload: { categoryId: id, monthlyAmount, effectiveFrom } }); expect(response.statusCode).toBe(200);
    }
    expect(db.prepare('SELECT monthly_amount FROM budgets ORDER BY effective_from').pluck().all()).toEqual([100, 300]);
    const status = (await app.inject('/api/budgets?cycle=2026-09')).json(); expect(status.find((b: { categoryId: number }) => b.categoryId === id).budget).toBe(300);
    await app.inject({ method: 'PUT', url: '/api/budgets', payload: { categoryId: id, monthlyAmount: null, effectiveFrom: '2026-09' } });
    expect(db.prepare('SELECT monthly_amount FROM budgets').pluck().all()).toEqual([100]);
  });
  it('alert seen is stable, dismissal hides it, and undo restores it', async () => {
    const id = Number(db.prepare("INSERT INTO alerts (type,severity,dedupe_key,title,message) VALUES ('test','warning','test','Test','Invented')").run().lastInsertRowid);
    await app.inject({ method: 'PATCH', url: `/api/alerts/${id}`, payload: { seen: true, dismissed: true } });
    const seen = db.prepare('SELECT seen_at FROM alerts').pluck().get(); expect(seen).not.toBeNull();
    expect((await app.inject('/api/alerts')).json()).toEqual([]); expect((await app.inject('/api/alerts?all=1')).json()).toHaveLength(1);
    await app.inject({ method: 'PATCH', url: `/api/alerts/${id}`, payload: { seen: true, dismissed: false } });
    expect(db.prepare('SELECT seen_at FROM alerts').pluck().get()).toBe(seen); expect((await app.inject('/api/alerts')).json()).toHaveLength(1);
  });
  it('recommendation state upsert and clearing use the same key', async () => {
    for (const state of ['dismissed', 'snoozed']) await app.inject({ method: 'POST', url: '/api/recommendations/state', payload: { key: 'test', state, until: '2026-10-01' } });
    expect(db.prepare('SELECT key,state,until FROM recommendation_states').all()).toEqual([{ key: 'test', state: 'snoozed', until: '2026-10-01' }]);
    await app.inject({ method: 'POST', url: '/api/recommendations/state', payload: { key: 'test', state: null } }); expect(db.prepare('SELECT COUNT(*) FROM recommendation_states').pluck().get()).toBe(0);
  });
  it('business report and CSV expose the business share and correctly escape invented text', async () => {
    const business = Number(db.prepare("INSERT INTO businesses (name) VALUES ('Invented business')").run().lastInsertRowid);
    const expense = addTx(db, { account: 'bank:test', date: '2026-09-01', description: 'Test "quoted", purchase', amount: -100, kind: 'expense' });
    const income = addTx(db, { account: 'bank:test', date: '2026-09-02', description: 'Test sale', amount: 200, kind: 'income' });
    db.prepare('UPDATE transactions SET business_id=?, business_share_pct=50 WHERE id IN (?,?)').run(business, expense, income);
    const report = (await app.inject(`/api/businesses/${business}/report?from=2026-09-01&to=2026-09-30`)).json();
    expect(report.totals).toEqual({ income: 100, expenses: 50 });
    const csv = await app.inject(`/api/businesses/${business}/export.csv`); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.body).toContain('"Test ""quoted"", purchase"'); expect(csv.body).toContain('"-50.00"');
  });
  it('sync status reports latest run and last success rather than presenting old failure', async () => {
    db.prepare("INSERT INTO scrape_runs (company,started_at,success) VALUES ('invented','2026-09-01',1), ('invented','2026-09-02',0)").run();
    expect((await app.inject('/api/sync-status')).json()).toEqual([expect.objectContaining({ company: 'invented', success: 0, lastSuccess: '2026-09-01' })]);
  });
});
