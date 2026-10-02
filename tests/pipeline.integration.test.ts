import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { runPipeline } from '../src/pipeline.js';
import { loadTransactions } from '../src/analytics/common.js';
import { refreshAlerts } from '../src/analytics/alerts.js';
import { buildRecommendations } from '../src/analytics/recommendations.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';
let db: DB;
beforeEach(() => { db = testDb(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00:00Z')); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network'); })); addAccount(db, 'bank:test', 'bank'); addAccount(db, 'card:test', 'card', 1, 'bank:test'); addBalance(db, 'bank:test', 10000); });
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('whole classification and analytics pipeline', () => {
  it('classifies, derives recurrence and suggestions, stores alerts, and is repeatable without network', async () => {
    for (const month of ['06', '07', '08']) {
      addTx(db, { account: 'bank:test', date: `2026-${month}-10`, description: 'Salary', amount: 1000 });
      addTx(db, { account: 'card:test', date: `2026-${month}-05`, description: 'Netflix', amount: -100 });
      addTx(db, { account: 'card:test', date: `2026-${month}-05`, description: 'Spotify', amount: -50 });
    }
    const fee = addTx(db, { account: 'bank:test', date: '2026-09-10', description: 'עמלה', amount: -20 });
    const first = await runPipeline(db, { fetchRates: false });
    expect(first).toMatchObject({ recurring: 3, paybacks: 0 }); expect(first.scheduled).toBeGreaterThan(0); expect(first.alerts).toBeGreaterThan(0);
    expect(loadTransactions(db).find(t => t.id === fee)?.kind).toBe('expense');
    const scheduled = db.prepare('SELECT COUNT(*) FROM scheduled_items').pluck().get();
    const alertCount = db.prepare('SELECT COUNT(*) FROM alerts').pluck().get();
    const second = await runPipeline(db, { fetchRates: false }); expect(second.alerts).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM scheduled_items').pluck().get()).toBe(scheduled);
    expect(db.prepare('SELECT COUNT(*) FROM alerts').pluck().get()).toBe(alertCount);
    expect(fetch).not.toHaveBeenCalled();
    const recs = buildRecommendations(db, '2026-09-15');
    expect(recs.find(r => r.type === 'overlap')).toMatchObject({ monthlySaving: 100, annualSaving: 1200 });
    expect(recs.find(r => r.key === 'subscriptions:review')).toMatchObject({ monthlySaving: 37.5, annualSaving: 450 });
    expect(recs.find(r => r.key === 'fees:bank')).toMatchObject({ monthlySaving: 6.67, annualSaving: 80 });
  });
  it('alert refresh preserves seen and dismissed state and ignores a superseded scrape failure', () => {
    addTx(db, { account: 'bank:test', date: '2026-09-10', description: 'עמלה', amount: -20, kind: 'expense' });
    db.prepare("INSERT INTO scrape_runs (company, success, started_at) VALUES ('invented', 0, '2026-09-01'), ('invented', 1, '2026-09-02')").run();
    expect(refreshAlerts(db, '2026-09-15')).toBeGreaterThan(0);
    db.prepare("UPDATE alerts SET seen_at='2026-09-15', dismissed_at='2026-09-15'").run();
    expect(refreshAlerts(db, '2026-09-15')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM alerts WHERE seen_at IS NULL OR dismissed_at IS NULL').pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM alerts WHERE type='scrape_failed'").pluck().get()).toBe(0);
  });
  it.each(['dismissed', 'done', 'snoozed'])('honors %s recommendation state and expiry', state => {
    addTx(db, { account: 'bank:test', date: '2026-09-01', description: 'עמלה', amount: -30, kind: 'expense' });
    db.prepare("INSERT INTO recommendation_states (key, state, until) VALUES ('fees:bank', ?, '2026-09-16')").run(state);
    expect(buildRecommendations(db, '2026-09-15').some(r => r.key === 'fees:bank')).toBe(false);
    expect(buildRecommendations(db, '2026-09-17').some(r => r.key === 'fees:bank')).toBe(state === 'snoozed');
  });
  it('external rate outages are nonfatal and manual kind/category survive reprocessing', async () => {
    const id = addTx(db, { account: 'bank:test', date: '2026-09-01', description: 'Test', amount: -20, kind: 'transfer' });
    db.prepare("UPDATE transactions SET kind_source='manual' WHERE id=?").run(id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runPipeline(db)).resolves.toBeDefined(); expect(loadTransactions(db)[0].kind).toBe('transfer'); expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
});
