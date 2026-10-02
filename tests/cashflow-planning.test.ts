import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { expectedIncome, monthIncome, spendBaseline } from '../src/analytics/cashflow.js';
import { refreshRecurring } from '../src/analytics/recurring.js';
import { savingsCapacity, tightMonthPlan } from '../src/analytics/planning.js';
import { cycleByKey } from '../src/analytics/common.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';
let db: DB;
beforeEach(() => { db = testDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z')); addAccount(db, 'bank:test', 'bank'); addBalance(db, 'bank:test', 10000); db.exec('DELETE FROM sinking_funds'); });
afterEach(() => { db.close(); vi.useRealTimers(); });
function history() {
  for (const month of ['06', '07', '08']) {
    addTx(db, { account: 'bank:test', date: `2026-${month}-10`, description: 'Salary', amount: 2000, kind: 'income' });
    addTx(db, { account: 'bank:test', date: `2026-${month}-15`, description: 'Other income', amount: 100, kind: 'income' });
    addTx(db, { account: 'bank:test', date: `2026-${month}-12`, description: 'Variable', amount: -400, kind: 'expense' });
  }
  refreshRecurring(db, '2026-09-15');
}
describe('month income versus typical income', () => {
  it('pending recurring income is included in an open month but never invents income for a closed month', () => {
    history();
    const september = monthIncome(db, {}, cycleByKey('2026-09', 1), '2026-09-15');
    expect(september).toMatchObject({ received: 0, pending: 2100, total: 2100, other: 0 });
    expect(september.recurring.every(r => !r.received && r.date === '2026-09-15')).toBe(true);
    expect(monthIncome(db, {}, cycleByKey('2026-05', 1), '2026-09-15')).toMatchObject({ received: 0, pending: 0, total: 0 });
  });
  it('actual recurring receipt replaces estimate, while extra one-off income remains separate', () => {
    history();
    addTx(db, { account: 'bank:test', date: '2026-09-10', description: 'Salary', amount: 2200, kind: 'income' });
    addTx(db, { account: 'bank:test', date: '2026-09-11', description: 'Gift', amount: 50, kind: 'income' });
    const result = monthIncome(db, {}, undefined, '2026-09-15');
    expect(result).toMatchObject({ received: 2250, pending: 100, total: 2350, other: 50 });
    expect(result.recurring.find(r => r.name === 'Salary')).toMatchObject({ received: true, amount: 2200, date: '2026-09-10' });
    expect(expectedIncome(db, {}, '2026-09-15')).toMatchObject({ recurringTotal: 2100, irregularAverage: 0, expectedMonthly: 2100 });
    expect(monthIncome(db, { memberId: 2 }, undefined, '2026-09-15').total).toBe(0);
  });
});
describe('capacity and tight month', () => {
  it('skips uncovered months and allocates positive capacity proportional to targets', () => {
    history();
    db.prepare("INSERT INTO sinking_funds (name, monthly_target) VALUES ('A', 3), ('B', 1)").run();
    const baseline = spendBaseline(db, {}, 6, '2026-09-15'); expect(baseline.dynamic).toBe(400); expect(baseline.history).toHaveLength(3);
    const capacity = savingsCapacity(db, {}, '2026-09-15');
    expect(capacity).toMatchObject({ expectedIncome: 2100, monthlyCapacity: 1700, averageDynamic: 400, irregularReserve: 0 });
    expect(capacity.allocation.map(a => a.amount)).toEqual([1275, 425]);
  });
  it('negative capacity never allocates negative savings', () => {
    for (const month of ['06', '07', '08']) {
      addTx(db, { account: 'bank:test', date: `2026-${month}-10`, description: 'Salary', amount: 100, kind: 'income' });
      addTx(db, { account: 'bank:test', date: `2026-${month}-12`, description: 'Spend', amount: -500, kind: 'expense' });
    }
    refreshRecurring(db, '2026-09-15');
    db.prepare("INSERT INTO sinking_funds (name, monthly_target) VALUES ('A', 100)").run();
    const capacity = savingsCapacity(db, {}, '2026-09-15'); expect(capacity.monthlyCapacity).toBe(-400); expect(capacity.allocation[0].amount).toBe(0);
  });
  it('tight month proposes bounded cuts only for discretionary spend', () => {
    const category = Number(db.prepare("INSERT INTO categories (name, discretionary) VALUES ('Invented discretionary', 1)").run().lastInsertRowid);
    for (const month of ['06', '07', '08']) addTx(db, { account: 'bank:test', date: `2026-${month}-01`, description: 'Shopping', amount: -100, kind: 'expense', categoryId: category });
    addTx(db, { account: 'bank:test', date: '2026-09-01', description: 'Shopping', amount: -1000, kind: 'expense', categoryId: category });
    const plan = tightMonthPlan(db, '2026-09-15'); expect(plan.isTight).toBe(true); expect(plan.reasons.length).toBeGreaterThan(0); expect(plan.cuts).toHaveLength(1);
    for (const c of plan.cuts) { expect(c.suggestedCut).toBeGreaterThan(0); expect(c.suggestedCut).toBeLessThanOrEqual(c.projected - c.spentSoFar + 0.01); }
  });
});
