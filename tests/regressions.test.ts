import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { importPensionReport } from '../src/import/pensionReport.js';
import { netWorth } from '../src/analytics/networth.js';
import { addMonthsClamped, isCalendarDate, transactionRoutes } from '../src/server/routes/transactions.js';
import { addAccount, testDb } from './helpers.js';
import { migrations } from '../src/db/migrations.js';
import Database from 'better-sqlite3';

let db: DB;
beforeEach(() => { db = testDb(); });
afterEach(() => db.close());

describe('regressions for four fixed defects', () => {
  it('pension re-import must not duplicate deposits with an unknown salary month', () => {
    db.prepare("UPDATE members SET name='Invented member' WHERE id=1").run();
    const r = { asOf: '2026-09-01', member: 'Invented member', source: 'Synthetic', summary: { totalSavings: 100 },
      products: [{ type: 'pension' as const, name: 'Invented', provider: 'Provider', policyNumber: 'TEST', balance: 100, status: 'active' as const,
        deposits: [['2026-08-01', null, null, null, null, null, 10] as [string, null, null, null, null, null, number]] }] };
    importPensionReport(db, r); importPensionReport(db, r);
    expect(db.prepare('SELECT COUNT(*) FROM asset_deposits').pluck().get()).toBe(1);
  });
  it('net worth history must choose newest dated snapshot, not newest inserted ID', () => {
    const id = Number(db.prepare("INSERT INTO assets (name, type) VALUES ('Invented', 'deposit')").run().lastInsertRowid);
    const insert = db.prepare("INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')");
    insert.run(id, '2026-09-15', 200); insert.run(id, '2026-09-01', 100);
    const result = netWorth(db, '2026-09-30');
    expect(result.items[0].valueIls).toBe(200);
    expect(result.history).toEqual([{ date: '2026-09', netWorth: 200 }]);
  });
  it('manual transactions reject impossible calendar dates instead of rolling into March', async () => {
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date: '2026-02-31', description: 'Invented', amount: 10 } });
      expect(response.statusCode).toBe(400);
      expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(0);
    } finally { await app.close(); }
  });
  it('postponing January 31 by a month clamps to February rather than skipping February', async () => {
    addAccount(db, 'bank:test', 'bank');
    const id = Number(db.prepare("INSERT INTO planned_items (description, amount, date, account_id) VALUES ('Invented', 100, '2026-01-31', 'bank:test')").run().lastInsertRowid);
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { postponeMonths: 1 } });
      expect(response.statusCode).toBe(200);
      expect(db.prepare('SELECT date FROM planned_items WHERE id=?').pluck().get(id)).toBe('2026-02-28');
    } finally { await app.close(); }
  });

  it('pension re-import updates the NULL-month deposit in place and keeps distinct dates and months apart', () => {
    db.prepare("UPDATE members SET name='Invented member' WHERE id=1").run();
    const row = (date: string, month: string | null, total: number) => [date, month, null, null, null, null, total] as [string, string | null, null, null, null, null, number];
    const report = (total: number) => ({ asOf: '2026-09-01', member: 'Invented member', source: 'Synthetic', summary: { totalSavings: 100 },
      products: [{ type: 'pension' as const, name: 'Invented', provider: 'Provider', policyNumber: 'TEST', balance: 100, status: 'active' as const,
        deposits: [row('2026-08-01', null, total), row('2026-07-01', null, 5), row('2026-08-01', '2026-07', 7)] }] });
    importPensionReport(db, report(10)); importPensionReport(db, report(12)); importPensionReport(db, report(12));
    expect(db.prepare('SELECT COUNT(*) FROM asset_deposits').pluck().get()).toBe(3);
    expect(db.prepare("SELECT total FROM asset_deposits WHERE value_date='2026-08-01' AND salary_month IS NULL").pluck().get()).toBe(12);
  });
  it('migration 15 removes existing NULL-month duplicates (newest kept), leaves other rows, and is enforced afterwards', () => {
    const old = new Database(':memory:');
    try {
      old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
      for (const m of migrations.filter(m => m.version <= 14)) { old.transaction(() => { m.up(old); old.prepare('INSERT INTO schema_version (version,name) VALUES (?,?)').run(m.version, m.name); })(); }
      const asset = Number(old.prepare("INSERT INTO assets (name, type) VALUES ('Invented', 'pension')").run().lastInsertRowid);
      const ins = old.prepare('INSERT INTO asset_deposits (asset_id, value_date, salary_month, total) VALUES (?, ?, ?, ?)');
      ins.run(asset, '2026-08-01', null, 1); ins.run(asset, '2026-08-01', null, 2); ins.run(asset, '2026-08-01', null, 3);
      ins.run(asset, '2026-08-01', '2026-07', 4); ins.run(asset, '2026-07-01', null, 5);
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const m15 = migrations.find(m => m.version === 15)!; old.transaction(() => m15.up(old))();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('removed 2 duplicates'));
        expect(old.prepare('SELECT total FROM asset_deposits_dedup_backup_v15 ORDER BY total').pluck().all()).toEqual([1, 2]);
      } finally { log.mockRestore(); }
      expect(old.prepare('SELECT total FROM asset_deposits ORDER BY total').pluck().all()).toEqual([3, 4, 5]);
      expect(() => ins.run(asset, '2026-08-01', null, 9)).toThrow(/UNIQUE/);
      expect(old.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { old.close(); }
  });
  it('net worth history uses the latest dated snapshot per asset and liability, ignoring insertion order', () => {
    const asset = Number(db.prepare("INSERT INTO assets (name, type) VALUES ('Invented', 'deposit')").run().lastInsertRowid);
    const liability = Number(db.prepare("INSERT INTO liabilities (name, type) VALUES ('Invented loan', 'loan')").run().lastInsertRowid);
    const a = db.prepare("INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')");
    const l = db.prepare('INSERT INTO liability_snapshots (liability_id, date, balance) VALUES (?, ?, ?)');
    a.run(asset, '2026-09-15', 200); a.run(asset, '2026-09-01', 100); a.run(asset, '2026-08-10', 50); a.run(asset, '2026-10-05', 999);
    l.run(liability, '2026-09-20', 30); l.run(liability, '2026-09-02', 90);
    expect(netWorth(db, '2026-09-30').history).toEqual([
      { date: '2026-08', netWorth: 50 }, { date: '2026-09', netWorth: 170 }, { date: '2026-10', netWorth: 969 }]);
  });
  it('manual transactions reject impossible dates on create and edit, and accept leap days', async () => {
    const app = Fastify(); transactionRoutes(app, db);
    try {
      for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', 'nope']) {
        const r = await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date, description: 'Invented', amount: 10 } });
        expect(r.statusCode, date).toBe(400);
      }
      const ok = await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date: '2028-02-29', description: 'Invented', amount: 10 } });
      expect(ok.statusCode).toBe(200);
      const id = ok.json().id;
      const bad = await app.inject({ method: 'PUT', url: `/api/transactions/${id}/manual`, payload: { date: '2026-02-31', description: 'Invented', amount: 10 } });
      expect(bad.statusCode).toBe(400);
      expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
    } finally { await app.close(); }
  });
  it('planned expenses reject impossible dates', async () => {
    addAccount(db, 'bank:test', 'bank');
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const r = await app.inject({ method: 'POST', url: '/api/planned', payload: { date: '2026-02-30', description: 'Invented', amount: 10, accountId: 'bank:test' } });
      expect(r.statusCode).toBe(400);
      expect(db.prepare('SELECT COUNT(*) FROM planned_items').pluck().get()).toBe(0);
    } finally { await app.close(); }
  });
  it('postpone returns 404 for missing items and leaves the date alone for 0 months', async () => {
    addAccount(db, 'bank:test', 'bank');
    const id = Number(db.prepare("INSERT INTO planned_items (description, amount, date, account_id) VALUES ('Invented', 100, '2026-03-31', 'bank:test')").run().lastInsertRowid);
    const app = Fastify(); transactionRoutes(app, db);
    try {
      expect((await app.inject({ method: 'PATCH', url: '/api/planned/9999', payload: { postponeMonths: 1 } })).statusCode).toBe(404);
      await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { postponeMonths: 0 } });
      expect(db.prepare('SELECT date FROM planned_items WHERE id=?').pluck().get(id)).toBe('2026-03-31');
      await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { postponeMonths: 1 } });
      expect(db.prepare('SELECT date FROM planned_items WHERE id=?').pluck().get(id)).toBe('2026-04-30');
    } finally { await app.close(); }
  });
});

describe('date helpers', () => {
  it.each([['2026-01-31', 1, '2026-02-28'], ['2028-01-31', 1, '2028-02-29'], ['2026-01-30', 1, '2026-02-28'], ['2026-03-31', 1, '2026-04-30'],
    ['2026-12-15', 1, '2027-01-15'], ['2026-11-30', 3, '2027-02-28'], ['2026-01-31', 12, '2027-01-31'], ['2026-03-31', -1, '2026-02-28'],
    ['2026-01-15', -2, '2025-11-15'], ['2026-05-10', 0, '2026-05-10']])('%s + %i months = %s', (date, n, expected) => {
    expect(addMonthsClamped(date, n)).toBe(expected);
  });
  it('isCalendarDate accepts only real dates', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true); expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate(20260101)).toBe(false); expect(isCalendarDate(undefined)).toBe(false);
  });
});

describe('planned PATCH validation', () => {
  it.each(['abc', '1', 1.5, 1e9, -121, 121, null, true])('rejects invalid offset %s without changing status or date', async offset => {
    addAccount(db, 'bank:test', 'bank');
    const id = Number(db.prepare("INSERT INTO planned_items (description, amount, date, account_id) VALUES ('Invented', 100, '2026-01-31', 'bank:test')").run().lastInsertRowid);
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { status: 'cancelled', postponeMonths: offset } });
      expect(response.statusCode).toBe(400);
      expect(db.prepare('SELECT date,status FROM planned_items WHERE id=?').get(id)).toEqual({date: '2026-01-31', status: 'planned'});
    } finally { await app.close(); }
  });
  it.each([{ status: 'cancelled' }, { status: 'planned' }, { postponeMonths: 0 }])('returns 404 for missing item %j', async payload => {
    const app = Fastify(); transactionRoutes(app, db);
    try { expect((await app.inject({ method: 'PATCH', url: '/api/planned/9999', payload })).statusCode).toBe(404); }
    finally { await app.close(); }
  });
  it.each(['broken', '2200-12-31', '1900-01-01'])('rejects invalid stored or out-of-range result %s', async date => {
    addAccount(db, 'bank:test', 'bank');
    const id = Number(db.prepare("INSERT INTO planned_items (description, amount, date, account_id) VALUES ('Invented', 100, ?, 'bank:test')").run(date).lastInsertRowid);
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { status: 'cancelled', postponeMonths: date.startsWith('1900') ? -1 : 1 } });
      expect(response.statusCode).toBe(400);
      expect(db.prepare('SELECT date,status FROM planned_items WHERE id=?').get(id)).toEqual({date, status: 'planned'});
    } finally { await app.close(); }
  });
  it('helper rejects unsafe offsets and unsupported calendar dates', () => {
    for (const n of [NaN, Infinity, 1.5, 1e9, -121]) expect(() => addMonthsClamped('2026-01-01', n)).toThrow(RangeError);
    for (const d of ['0099-01-01', '0000-01-01', '1899-12-31', '2201-01-01', '2026-02-31']) {
      expect(isCalendarDate(d)).toBe(false); expect(() => addMonthsClamped(d, 1)).toThrow(RangeError);
    }
    expect(addMonthsClamped('2026-01-01', 120)).toBe('2036-01-01');
    expect(addMonthsClamped('2026-01-01', -120)).toBe('2016-01-01');
  });
});
