import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { recurringTransfers, suggestCardCommitments, suggestScheduledItems, listScheduled } from '../src/analytics/scheduled.js';
import { loadTransactions } from '../src/analytics/common.js';
import { refreshRecurring } from '../src/analytics/recurring.js';
import { addAccount, addTx, testDb } from './helpers.js';
let db: DB;
beforeEach(() => { db = testDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z')); addAccount(db, 'bank:from', 'bank'); addAccount(db, 'bank:to', 'bank'); addAccount(db, 'card:1234', 'card', 1, 'bank:from'); });
afterEach(() => { db.close(); vi.useRealTimers(); });
describe('scheduled commitments and transfer pairs', () => {
  it('three distinct months of matched own-account transfers produce both forecast sides', () => {
    for (const month of ['06', '07', '08']) {
      addTx(db, { account: 'bank:from', date: `2026-${month}-05`, description: 'Transfer out', amount: -1000, kind: 'transfer' });
      addTx(db, { account: 'bank:to', date: `2026-${month}-06`, description: 'Transfer in', amount: 1000, kind: 'transfer' });
    }
    expect(recurringTransfers(loadTransactions(db), '2026-09-15')).toEqual([expect.objectContaining({ from: 'bank:from', to: 'bank:to', amount: 1000, day: 5, months: 3 })]);
    expect(suggestScheduledItems(db)).toBe(2);
    expect(listScheduled(db).map(s => [s.kind, s.amount, s.bank_account_id])).toEqual([['fixed_expense', -1000, 'bank:from'], ['income', 1000, 'bank:to']]);
    suggestScheduledItems(db); expect(listScheduled(db)).toHaveLength(2);
  });
  it('does not infer recurrent transfers from same-account or unmatched amounts', () => {
    for (const month of ['06', '07', '08']) {
      addTx(db, { account: 'bank:from', date: `2026-${month}-05`, description: 'Out', amount: -1000, kind: 'transfer' });
      addTx(db, { account: 'bank:from', date: `2026-${month}-05`, description: 'In', amount: 1000, kind: 'transfer' });
      addTx(db, { account: 'bank:to', date: `2026-${month}-05`, description: 'Other', amount: 900, kind: 'transfer' });
    }
    expect(recurringTransfers(loadTransactions(db), '2026-09-15')).toEqual([]);
  });
  it('fixed card commitments sum each month and preserve confirmed fixed user values', () => {
    const category = Number(db.prepare("INSERT INTO categories (name, default_fixed) VALUES ('Invented fixed', 1)").run().lastInsertRowid);
    for (const month of ['07', '08']) for (const amount of [40, 60]) addTx(db, { account: 'card:1234', date: `2026-${month}-10`, description: 'FACEBK A123', amount: -amount, kind: 'expense', categoryId: category });
    expect(suggestCardCommitments(db, loadTransactions(db), '2026-09-15')).toBe(1);
    expect(listScheduled(db)[0]).toMatchObject({ name: 'FACEBK', amount: -100, day_of_month: 10, bank_account_id: null, card_account_id: 'card:1234' });
    db.prepare("UPDATE scheduled_items SET status='confirmed', amount_mode='fixed', name='User name', amount=-77, day_of_month=2").run();
    expect(suggestCardCommitments(db, loadTransactions(db), '2026-09-15')).toBe(0);
    expect(listScheduled(db)[0]).toMatchObject({ name: 'User name', amount: -77, day_of_month: 2 });
    db.prepare("UPDATE scheduled_items SET status='dismissed'").run(); expect(listScheduled(db)).toEqual([]); expect(listScheduled(db, true)).toHaveLength(1);
  });
  it('estimated suggestions follow changed history but do not recreate dismissed fixed commitments', () => {
    const category = Number(db.prepare("INSERT INTO categories (name, default_fixed) VALUES ('Invented fixed', 1)").run().lastInsertRowid);
    for (const month of ['07', '08']) addTx(db, { account: 'card:1234', date: `2026-${month}-10`, description: 'Service', amount: -100, kind: 'expense', categoryId: category });
    suggestCardCommitments(db, loadTransactions(db), '2026-09-15');
    db.prepare('UPDATE transactions SET charged_amount=-120').run();
    suggestCardCommitments(db, loadTransactions(db), '2026-09-15'); expect(listScheduled(db)[0].amount).toBe(-120);
    db.prepare("UPDATE scheduled_items SET status='dismissed', amount_mode='fixed', amount=-80").run();
    suggestCardCommitments(db, loadTransactions(db), '2026-09-15'); expect(listScheduled(db, true)[0].amount).toBe(-80); expect(listScheduled(db)).toEqual([]);
  });
  it('suggests card statement from at least three purchases and removes it when card becomes debit', () => {
    for (const amount of [100, 200, 300]) addTx(db, { account: 'card:1234', date: '2026-08-01', processedDate: '2026-09-10', description: 'Invented purchase', amount: -amount, kind: 'expense' });
    suggestScheduledItems(db); expect(listScheduled(db)[0]).toMatchObject({ kind: 'card_charge', amount: -600, day_of_month: 10, bank_account_id: 'bank:from' });
    db.prepare("UPDATE accounts SET is_debit=1 WHERE id='card:1234'").run(); suggestScheduledItems(db); expect(listScheduled(db)).toEqual([]);
  });
  it('salary suggestions follow history until user confirms a fixed amount', () => {
    for (const month of ['06', '07', '08']) addTx(db, { account: 'bank:from', date: `2026-${month}-10`, description: 'Salary', amount: 2000, kind: 'income' });
    refreshRecurring(db, '2026-09-15'); suggestScheduledItems(db); expect(listScheduled(db)[0]).toMatchObject({ kind: 'income', amount: 2000 });
    db.prepare("UPDATE scheduled_items SET status='confirmed', amount_mode='fixed', amount=1500, day_of_month=2").run();
    db.prepare('UPDATE recurring_series SET typical_amount=3000, typical_day=20').run(); suggestScheduledItems(db);
    expect(listScheduled(db)[0]).toMatchObject({ amount: 1500, day_of_month: 2 });
  });
});
