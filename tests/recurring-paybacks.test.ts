import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { loadTransactions } from '../src/analytics/common.js';
import { detectRecurring, nextMonthlyDate, refreshRecurring } from '../src/analytics/recurring.js';
import { findPaybackCandidates, suggestPaybacks } from '../src/analytics/paybacks.js';
import { addAccount, addTx, testDb } from './helpers.js';

let db: DB;
beforeEach(() => {
  db = testDb();
  addAccount(db, 'bank:test', 'bank');
  addAccount(db, 'card:test', 'card');
});
afterEach(() => { db.close(); vi.useRealTimers(); });

function monthly(description: string, amounts: number[], account = 'bank:test') {
  return amounts.map((amount, i) => addTx(db, { account, date: `2026-0${i + 6}-10`, description, amount,
    kind: amount > 0 ? 'income' : 'expense' }));
}

describe('recurring detection and persistence', () => {
  it.each([
    ['2024-01-31', 31, '2024-02-29'], ['2025-01-31', 31, '2025-02-28'],
    ['2026-12-31', 10, '2027-01-10'], ['2026-03-31', 31, '2026-04-30'],
  ])('clamps %s, day %i to %s', (date, day, expected) => {
    expect(nextMonthlyDate(date, day)).toBe(expected);
  });
  it.each([
    ['Service', [-100, -100, -100], 'subscription', 100],
    ['Electricity', [-100, -120, -140], 'bill', 120],
    ['Mortgage', [-500, -500, -500], 'loan', 500],
    ['Salary', [1000, 1000, 1000], 'salary', 1000],
    ['Allowance', [100, 100, 100], 'income', 100],
  ])('classifies %s from distinct months', (description, amounts, kind, typicalAmount) => {
    monthly(description, amounts);
    expect(detectRecurring(loadTransactions(db), '2026-09-15')).toEqual([
      expect.objectContaining({ kind, typicalAmount, occurrences: 3, typicalDay: 10, nextExpectedDate: '2026-09-10' }),
    ]);
  });
  it('requires three distinct recent months, not three purchases in one month', () => {
    for (const day of ['01', '10', '20']) addTx(db, { account: 'bank:test', date: `2026-08-${day}`, description: 'Service', amount: -100, kind: 'expense' });
    expect(detectRecurring(loadTransactions(db), '2026-09-15')).toEqual([]);
  });
  it('does not merge different accounts or inflows with outflows', () => {
    monthly('Service', [-100, -100]);
    addTx(db, { account: 'card:test', date: '2026-08-10', description: 'Service', amount: -100, kind: 'expense' });
    addTx(db, { account: 'bank:test', date: '2026-08-10', description: 'Service', amount: 100, kind: 'income' });
    expect(detectRecurring(loadTransactions(db), '2026-09-15')).toEqual([]);
  });
  it.each(['transfer', 'card_payment', 'savings'])('ignores non-spend %s', kind => {
    const ids = monthly('Service', [-100, -100, -100]);
    for (const id of ids) db.prepare('UPDATE transactions SET kind = ? WHERE id = ?').run(kind, id);
    expect(detectRecurring(loadTransactions(db), '2026-09-15')).toEqual([]);
  });
  it('ignores installment plans and generic bank card descriptors', () => {
    const ids = monthly('Plan', [-100, -100, -100]);
    for (const id of ids) db.prepare("UPDATE transactions SET txn_type = 'installments' WHERE id = ?").run(id);
    monthly('ויזה', [-200, -200, -200]);
    expect(detectRecurring(loadTransactions(db), '2026-09-15')).toEqual([]);
  });
  it('sums split monthly payments rather than treating each as the monthly amount', () => {
    monthly('Service', [-60, -60, -60]);
    monthly('Service', [-40, -40, -40]);
    expect(detectRecurring(loadTransactions(db), '2026-09-15')[0]).toMatchObject({ typicalAmount: 100, occurrences: 6 });
  });
  it('refresh is idempotent and deactivates series no longer observed', () => {
    monthly('Service', [-100, -100, -100]);
    refreshRecurring(db, '2026-09-15');
    refreshRecurring(db, '2026-09-15');
    expect(db.prepare('SELECT COUNT(*) FROM recurring_series').pluck().get()).toBe(1);
    refreshRecurring(db, '2027-09-15');
    expect(db.prepare('SELECT active FROM recurring_series').pluck().get()).toBe(0);
  });
});

describe('refund and P2P matching', () => {
  function expense(date = '2026-08-01', amount = -600, description = 'Shop') {
    return addTx(db, { account: 'card:test', date, description, amount, kind: 'expense' });
  }
  function inflow(date = '2026-08-10', amount = 100, description = 'Bit', kind = 'income') {
    return addTx(db, { account: kind === 'refund' ? 'card:test' : 'bank:test', date, description, amount, kind });
  }
  const candidates = (existing = new Set<string>()) => findPaybackCandidates(loadTransactions(db), existing);
  it.each([1, 2, 3, 4, 5, 6])('matches a 1/%i P2P share', shares => {
    const e = expense(); const i = inflow('2026-08-10', 600 / shares);
    expect(candidates()).toEqual([expect.objectContaining({ inflowId: i, expenseId: e, type: 'payback', amount: 600 / shares })]);
  });
  it('matches the latest same-merchant partial refund', () => {
    expense('2026-07-01', -600);
    const latest = expense('2026-08-01', -300);
    const i = inflow('2026-08-10', 100, 'Shop', 'refund');
    expect(candidates()).toEqual([expect.objectContaining({ inflowId: i, expenseId: latest, type: 'refund' })]);
  });
  it.each([
    ['2026-09-01', 100, 'Bit', 'income'], // >30 days
    ['2026-07-31', 100, 'Bit', 'income'], // before expense
    ['2026-08-10', 100, 'Other', 'refund'], // different merchant
    ['2026-08-10', 700, 'Shop', 'refund'], // refund exceeds purchase
    ['2026-08-10', 100, 'Salary', 'income'], // not P2P
    ['2026-08-10', 100, 'Bit', 'transfer'],
    ['2026-08-10', 100, 'Bit', 'card_payment'],
  ])('rejects incompatible inflow %s %i %s %s', (date, amount, description, kind) => {
    expense(); inflow(date, amount, description, kind);
    expect(candidates()).toEqual([]);
  });
  it('never reuses an already linked inflow and persists suggestions once', () => {
    const e = expense(); const i = inflow();
    expect(candidates(new Set([`${i}|${e}`]))).toEqual([]);
    expect(suggestPaybacks(db)).toBe(1);
    expect(suggestPaybacks(db)).toBe(0);
    expect(db.prepare('SELECT from_txn_id, to_txn_id, status FROM transaction_links').get()).toEqual({ from_txn_id: i, to_txn_id: e, status: 'suggested' });
  });
});
