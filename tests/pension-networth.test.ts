import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { importPensionReport } from '../src/import/pensionReport.js';
import { pensionRoutes } from '../src/server/routes/pension.js';
import { netWorth } from '../src/analytics/networth.js';
import { setRate } from '../src/analytics/fx.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';

let db: DB; let app: FastifyInstance;
beforeEach(() => { db = testDb(); app = Fastify(); pensionRoutes(app, db); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z')); });
afterEach(async () => { await app.close(); db.close(); vi.useRealTimers(); });
const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
function report() {
  db.prepare("UPDATE members SET name='Invented member' WHERE id=1").run();
  return {
    asOf: '2026-09-01', member: 'Invented member', source: 'Synthetic report', file: 'invented.pdf',
    summary: { totalSavings: 3000 },
    products: [
      { type: 'pension' as const, name: 'Pension', provider: 'Invented provider', policyNumber: 'TEST-1', balance: 1000, status: 'active' as const, regularDeposit: 100, expectedAnnuity: 50,
        feeDeposit: 1, feeBalance: 0.2, tracks: [{ name: 'Invented track', share: 100, balance: 1000, returns: [null, null, null, null, null, null, null] as [null, null, null, null, null, null, null] }],
        deposits: [['2026-09-01', '2026-08', 1000, 30, 40, 30, 100] as [string, string, number, number, number, number, number]] },
      { type: 'keren_hishtalmut' as const, name: 'Study', provider: 'Invented provider', policyNumber: 'TEST-2', balance: 2000, status: 'inactive' as const, joinDate: '2019-09-01' },
    ],
    insurance: [{ name: 'Invented cover', type: 'life', insurer: 'Invented insurer', policyNumber: 'TEST-P', premium: 10, premiumFrequency: 'monthly', matchPattern: 'insurer' }],
  };
}

describe('pension report import and API', () => {
  it('imports products, report totals, insurance and deposits, and re-imports without duplicates', async () => {
    const r = report(); expect(importPensionReport(db, r)).toEqual({ assets: 2, created: 2, deposits: 1, policies: 1 });
    expect(importPensionReport(db, r)).toMatchObject({ assets: 2, created: 0 });
    expect([count('assets'), count('asset_snapshots'), count('asset_deposits'), count('pension_reports'), count('insurance_policies')]).toEqual([2, 2, 1, 1, 1]);
    const api = (await app.inject('/api/pension')).json();
    expect(api.totals).toMatchObject({ value: 3000, monthlyDeposits: 100, expectedAnnuity: 50, active: 1, inactive: { count: 1, value: 2000 }, liquidStudyFunds: { count: 1, value: 2000 } });
    expect(api.products[0].details.tracks[0].name).toBe('Invented track');
    expect(api.products[0].deposits[0]).toMatchObject({ salaryMonth: '2026-08', total: 100 });
    expect(api.report).toMatchObject({ documentPath: 'docs/reports/invented.pdf', summary: { totalSavings: 3000 } });
  });
  it('updates extracted values but preserves user names, notes, owners and insurance patterns', () => {
    const r = report(); importPensionReport(db, r);
    db.prepare("UPDATE assets SET name='User name', notes='User notes', owner_member_id=2").run();
    db.prepare("UPDATE insurance_policies SET notes='User notes', match_pattern='User pattern'").run();
    r.products[0].balance = 1500; r.summary.totalSavings = 3500; r.insurance[0].premium = 20;
    importPensionReport(db, r);
    expect(db.prepare('SELECT name, notes, owner_member_id FROM assets ORDER BY id').all()).toEqual([
      { name: 'User name', notes: 'User notes', owner_member_id: 2 }, { name: 'User name', notes: 'User notes', owner_member_id: 2 },
    ]);
    expect(db.prepare('SELECT premium, match_pattern, notes FROM insurance_policies').get()).toEqual({ premium: 20, match_pattern: 'User pattern', notes: 'User notes' });
    expect(db.prepare('SELECT value FROM asset_snapshots ORDER BY id').pluck().all()).toEqual([1500, 2000]);
  });
  it('rejects unknown members and inconsistent extraction totals before any writes', () => {
    const r = report(); r.member = 'Missing'; expect(() => importPensionReport(db, r)).toThrow('member not found');
    r.member = 'Invented member'; r.summary.totalSavings = 9000; expect(() => importPensionReport(db, r)).toThrow('check the extraction');
    expect(count('assets')).toBe(0); expect(count('pension_reports')).toBe(0);
  });
  it('rolls back all products when a later product violates a constraint', () => {
    const r = report(); r.products[1].type = 'invalid' as 'keren_hishtalmut';
    expect(() => importPensionReport(db, r)).toThrow();
    expect(count('assets')).toBe(0); expect(count('asset_snapshots')).toBe(0);
  });
  it('empty pension API returns stable zero totals', async () => {
    const r = (await app.inject('/api/pension')).json();
    expect(r.products).toEqual([]); expect(r.report).toBeNull(); expect(r.totals.value).toBe(0);
  });
});

describe('net worth valuation and liquidity', () => {
  function asset(type: string, value: number, currency = 'ILS', liquidity: string | null = null, archived = 0) {
    const id = Number(db.prepare('INSERT INTO assets (name, type, currency, liquidity_date, archived) VALUES (?, ?, ?, ?, ?)').run(`Invented ${type}`, type, currency, liquidity, archived).lastInsertRowid);
    db.prepare('INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, ?)').run(id, '2026-09-01', value, currency);
    return id;
  }
  it('converts FX, subtracts card debt and latest loan balance, excludes archived assets', () => {
    addAccount(db, 'bank:test', 'bank'); addBalance(db, 'bank:test', 1000, '2026-09-15T10:00:00Z');
    addAccount(db, 'card:test', 'card'); addTx(db, { account: 'card:test', date: '2026-09-01', processedDate: '2026-10-01', description: 'Future charge', amount: -200, kind: 'expense' });
    setRate(db, '2026-09-01', 'USD', 3); asset('deposit', 100, 'USD'); asset('other', 9000, 'ILS', null, 1);
    const loan = Number(db.prepare("INSERT INTO liabilities (name, type, original_principal) VALUES ('Invented loan', 'loan', 500)").run().lastInsertRowid);
    db.prepare('INSERT INTO liability_snapshots (liability_id, date, balance) VALUES (?, ?, ?), (?, ?, ?)').run(loan, '2026-08-01', 450, loan, '2026-09-01', 400);
    const n = netWorth(db, '2026-09-15');
    expect(n.totals).toEqual({ assets: 1300, liabilities: -600, netWorth: 700, liquid: 1300 });
    expect(n.byType).toEqual({ bank: 1000, deposit: 300, card: -200, loan: -400 });
    expect(n.items.find(i => i.group === 'liability')).toMatchObject({ valueIls: -400, asOf: '2026-09-01' });
  });
  it('pension and real estate are never liquid; gemel needs a reached liquidity date', () => {
    asset('pension', 1000); asset('real_estate', 2000); asset('kupat_gemel', 3000);
    asset('kupat_gemel', 4000, 'ILS', '2026-09-01'); asset('keren_hishtalmut', 5000, 'ILS', '2027-01-01');
    asset('keren_hishtalmut', 6000, 'ILS', '2026-09-15');
    expect(netWorth(db, '2026-09-15').totals).toMatchObject({ assets: 21000, liquid: 10000 });
  });
  it('uses latest asset snapshot by date rather than insertion order', () => {
    const id = asset('deposit', 200);
    db.prepare('INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, ?)').run(id, '2026-08-01', 100, 'ILS');
    expect(netWorth(db, '2026-09-15').items[0].valueIls).toBe(200);
  });
  it('empty household has zero totals and no history', () => {
    expect(netWorth(db, '2026-09-15').totals).toEqual({ assets: 0, liabilities: 0, netWorth: 0, liquid: 0 });
    expect(netWorth(db, '2026-09-15').history).toEqual([]);
  });
});
