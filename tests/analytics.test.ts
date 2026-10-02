import { describe, expect, it } from 'vitest';
import { cycleFor, loadTransactions, merchantKey, spendOf } from '../src/analytics/common.js';
import { installmentPlans, upcomingCardCharges } from '../src/analytics/cards.js';
import { projectForecast, type ForecastInput } from '../src/analytics/forecast.js';
import { supersedeByLiabilities, type ScheduledItem } from '../src/analytics/scheduled.js';
import { findDuplicateCharges, findAnomalies } from '../src/analytics/alerts.js';
import { findPaybackCandidates } from '../src/analytics/paybacks.js';
import { detectRecurring } from '../src/analytics/recurring.js';
import { summarizeCycle } from '../src/analytics/cashflow.js';
import { setRate, toIls } from '../src/analytics/fx.js';
import { monthPlan } from '../src/analytics/commitments.js';
import { addAccount, addTx, testDb } from './helpers.js';

const item = (over: Partial<ScheduledItem>): ScheduledItem => ({
  id: 1, name: 'x', kind: 'fixed_expense', amount: 0, amount_mode: 'fixed', day_of_month: 1,
  bank_account_id: 'bank:1', member_id: 1, category_id: null, match_pattern: null, card_account_id: null,
  liability_id: null, start_date: null, end_date: null, status: 'confirmed', ...over,
});

describe('cycles', () => {
  it('handles a custom start day', () => {
    expect(cycleFor('2026-09-05', 10)).toEqual({ key: '2026-08', start: '2026-08-10', end: '2026-09-09' });
    expect(cycleFor('2026-09-10', 10)).toEqual({ key: '2026-09', start: '2026-09-10', end: '2026-10-09' });
    expect(cycleFor('2026-12-31', 1)).toEqual({ key: '2026-12', start: '2026-12-01', end: '2026-12-31' });
  });
});

describe('merchantKey', () => {
  it('groups codes of the same merchant', () => {
    expect(merchantKey('FACEBK  A1B2C3D4E5')).toBe(merchantKey('FACEBK F6G7H8J9K0'));
    expect(merchantKey('GOOGLE CLOUD X1Y2Z3')).toBe('google cloud');
  });
});

describe('day-by-day forecast', () => {
  const base = (): ForecastInput => ({
    asOf: '2026-10-01',
    horizonEnd: '2026-10-31',
    cycleEnd: '2026-10-31',
    accounts: [{ id: 'bank:1', display_name: 'Leumi', owner_member_id: 1, last_scraped_at: null, balance: 3000, balanceDate: '2026-10-01 07:00:00' }],
    scheduled: [
      item({ name: 'מאסטרקרד', kind: 'income', amount: 12000, day_of_month: 10 }),
      item({ id: 2, name: 'משכנתא', kind: 'mortgage', amount: -7200, day_of_month: 5 }),
      item({ id: 3, name: 'ישראכרט', kind: 'card_charge', amount: -4000, amount_mode: 'estimated', day_of_month: 15, card_account_id: 'card:1' }),
    ],
    cardCharges: [],
    txs: [],
    buffer: 1000,
  });

  it('finds the lowest point before the salary arrives', () => {
    const f = projectForecast(base());
    const leumi = f.accounts[0];
    expect(leumi.lowest).toEqual({ date: '2026-10-05', amount: -4200 });
    expect(leumi.points.find(p => p.date === '2026-10-10')!.expected).toBe(7800);
    expect(leumi.endOfCycle).toBe(3800);
    expect(f.warnings.some(w => w.includes('-4,200') || w.includes('4,200'))).toBe(true);
  });

  it('does not count a scheduled item that already posted this month', () => {
    const db = testDb();
    addAccount(db, 'bank:1', 'bank');
    addTx(db, { account: 'bank:1', date: '2026-10-01', description: 'משכנתא', amount: -7200, kind: 'expense' });
    const input = { ...base(), asOf: '2026-10-02', txs: loadTransactions(db) };
    input.scheduled = input.scheduled.map(s => s.name === 'משכנתא' ? { ...s, day_of_month: 3 } : s);
    const f = projectForecast(input);
    expect(f.events.some(e => e.name === 'משכנתא' && e.date.startsWith('2026-10'))).toBe(false);
  });

  it('prefers a known card statement over the estimate for that month', () => {
    const input = base();
    input.cardCharges = [{ cardAccountId: 'card:1', company: 'isracard', displayName: 'ישראכרט', chargeDate: '2026-10-15',
      knownAmount: 2500, projectedInstallments: 0, projectedFixed: 0, fixedItems: [], projectedPlanned: 0, plannedItems: [], typicalAmount: 4000, knownVariable: 2500, typicalVariable: 4000, expectedAmount: 2500, transactions: 12, billingBankAccountId: 'bank:1', typicalChargeDay: 15 }];
    const f = projectForecast(input);
    const cardEvents = f.events.filter(e => e.kind === 'card_charge');
    expect(cardEvents).toHaveLength(1);
    expect(cardEvents[0].amount).toBe(-2500);
  });
});

describe('user-entered loans replace detected repayments', () => {
  it('dismisses the detected mortgage and car loan covered by the loans the user added', () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    const ins = db.prepare(`INSERT INTO scheduled_items (name, kind, amount, day_of_month, bank_account_id, match_pattern, liability_id, status)
      VALUES (?, ?, ?, 15, 'leumi:1', ?, ?, 'confirmed')`);
    const loan = (name: string) => Number(db.prepare(`INSERT INTO liabilities (name, type) VALUES (?, 'mortgage')`).run(name).lastInsertRowid);
    // detected from bank history
    const detectedMortgage = Number(ins.run('לאומי למשכנת-י', 'mortgage', -6747.30, 'לאומי למשכנת', null).lastInsertRowid);
    const detectedLoan = Number(ins.run('פרעון הלוואה', 'loan', -1250.50, 'פרעון הלוואה', null).lastInsertRowid);
    const otherLoan = Number(ins.run('הלוואה אחרת', 'loan', -500, 'הלוואה אחרת', null).lastInsertRowid);
    // entered on the Loans page: three mortgage tracks and the car loan
    // the first track has a description that never appears on the statement, the others have none
    const tracks = [-2300, -1880, -2006].map((a, i) => Number(ins.run(`מסלול ${i}`, 'mortgage', a, i === 0 ? 'משכנתא' : null, loan(`m${i}`)).lastInsertRowid));
    ins.run('הלוואת רכב', 'loan', -1250, null, loan('car'));
    const recently = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    addTx(db, { account: 'leumi:1', date: recently, description: 'לאומי למשכנת-י', amount: -6186.35, kind: 'expense' });

    expect(supersedeByLiabilities(db)).toBe(2);
    const status = (id: number) => db.prepare(`SELECT status FROM scheduled_items WHERE id = ?`).pluck().get(id);
    expect([status(detectedMortgage), status(detectedLoan), status(otherLoan)]).toEqual(['dismissed', 'dismissed', 'confirmed']);
    // the tracks take the bank description so an already-posted payment isn't counted again
    expect(tracks.map(t => db.prepare(`SELECT match_pattern FROM scheduled_items WHERE id = ?`).pluck().get(t))).toEqual(Array(3).fill('לאומי למשכנת'));
    // already dismissed: nothing more to do
    expect(supersedeByLiabilities(db)).toBe(0);
  });
});

describe('installments', () => {
  it('projects the remaining installments from the latest one', () => {
    const db = testDb();
    addAccount(db, 'visaCal:1', 'card');
    for (const n of [1, 2]) {
      addTx(db, { account: 'visaCal:1', date: '2026-08-10', processedDate: `2026-${String(8 + n).padStart(2, '0')}-14`, description: 'ELECTRO STORE',
        amount: -1980, txnType: 'installments', installmentNumber: n, installmentTotal: 4, kind: 'expense' });
    }
    const [plan] = installmentPlans(loadTransactions(db), '2026-10-20');
    expect(plan.remainingAmount).toBe(3960);
    expect(plan.schedule).toEqual({ '2026-11': 1980, '2026-12': 1980 });
  });

  it('keeps one plan when the card moves the date every month, counting scraped-ahead rows as not yet paid', () => {
    const db = testDb();
    addAccount(db, 'visaCal:1', 'card');
    for (const n of [1, 2, 3, 4]) {
      const m = String(6 + n).padStart(2, '0');
      addTx(db, { account: 'visaCal:1', date: `2026-${m}-12`, processedDate: `2026-${m}-15`, description: 'ELECTRO STORE',
        amount: -1980, txnType: 'installments', installmentNumber: n, installmentTotal: 4, kind: 'expense' });
    }
    const plans = installmentPlans(loadTransactions(db), '2026-09-30');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ purchaseDate: '2026-07-12', paid: 3, remaining: 1, nextChargeDate: '2026-10-15', remainingAmount: 1980 });
  });
});

describe('card charges include installments not reported yet', () => {
  it('adds the payments beyond the scraped months to that month\'s charge', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    for (const n of [1, 2]) {
      const m = String(8 + n).padStart(2, '0');
      addTx(db, { account: 'max:1', date: `2026-${m}-05`, processedDate: `2026-${m}-02`, description: 'רהיטים',
        amount: -500, txnType: 'installments', installmentNumber: n, installmentTotal: 4, kind: 'expense' });
    }
    addTx(db, { account: 'max:1', date: '2026-09-20', processedDate: '2026-10-02', description: 'סופר', amount: -120, kind: 'expense' });
    const charges = upcomingCardCharges(db, loadTransactions(db), '2026-09-30');
    const oct = charges.find(c => c.chargeDate === '2026-10-02')!;
    expect(oct).toMatchObject({ knownAmount: 620, projectedInstallments: 0 });
    const nov = charges.find(c => c.chargeDate.startsWith('2026-11'))!;
    expect(nov).toMatchObject({ chargeDate: '2026-11-02', knownAmount: 0, projectedInstallments: 500 });
    expect(nov.expectedAmount).toBeGreaterThanOrEqual(500);
    expect(charges.find(c => c.chargeDate.startsWith('2026-12'))!.projectedInstallments).toBe(500);
  });
});

describe('card charges include fixed card payments not reported yet', () => {
  const setup = () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    addAccount(db, 'max:1', 'card');
    db.prepare(`UPDATE accounts SET billing_bank_account_id = 'leumi:1' WHERE id = 'max:1'`).run();
    db.prepare(`INSERT INTO scheduled_items (name, kind, amount, day_of_month, card_account_id, match_pattern, status)
      VALUES ('טניס', 'fixed_expense', -300, 5, 'max:1', 'טניס', 'confirmed')`).run();
    // past statements on the 2nd; the tennis class bought on the 5th is charged the next month
    for (const m of ['08', '09']) {
      addTx(db, { account: 'max:1', date: `2026-${String(Number(m) - 1).padStart(2, '0')}-05`, processedDate: `2026-${m}-02`, description: 'מועדון טניס', amount: -300, kind: 'expense' });
      addTx(db, { account: 'max:1', date: `2026-${String(Number(m) - 1).padStart(2, '0')}-12`, processedDate: `2026-${m}-02`, description: 'רמי לוי', amount: -700, kind: 'expense' });
    }
    // the open October statement so far
    addTx(db, { account: 'max:1', date: '2026-09-20', processedDate: '2026-10-02', description: 'סופר', amount: -120, kind: 'expense' });
    return db;
  };

  it('adds the payment to the statement it lands in, until the card reports it', () => {
    const db = setup();
    const charges = upcomingCardCharges(db, loadTransactions(db), '2026-09-30');
    const oct = charges.find(c => c.chargeDate === '2026-10-02')!;
    // the statement is 2 days away, so the plan is what's known — plus the tennis the card hasn't reported
    expect(oct).toMatchObject({ knownAmount: 120, projectedFixed: 300, expectedAmount: 420, billingBankAccountId: 'leumi:1' });
    expect(oct.fixedItems).toEqual([{ scheduledId: 1, name: 'טניס', amount: 300, purchaseDate: '2026-09-05' }]);
    const nov = charges.find(c => c.chargeDate.startsWith('2026-11'))!;
    expect(nov).toMatchObject({ chargeDate: '2026-11-02', projectedFixed: 300 });

    // it flows into the bank forecast through the card charge
    const f = projectForecast({
      asOf: '2026-09-30', horizonEnd: '2026-10-31', cycleEnd: '2026-10-31', txs: loadTransactions(db), buffer: 0, scheduled: [],
      accounts: [{ id: 'leumi:1', display_name: 'Leumi', owner_member_id: 1, last_scraped_at: null, balance: 1000, balanceDate: '2026-09-30 07:00:00' }],
      cardCharges: charges,
    });
    expect(f.events.find(e => e.date === '2026-10-02')).toMatchObject({ kind: 'card_charge', amount: -420, accountId: 'leumi:1' });
  });

  it('does not count it twice once the card reported it', () => {
    const db = setup();
    addTx(db, { account: 'max:1', date: '2026-09-05', processedDate: '2026-10-02', description: 'מועדון טניס', amount: -300, kind: 'expense' });
    const oct = upcomingCardCharges(db, loadTransactions(db), '2026-09-30').find(c => c.chargeDate === '2026-10-02')!;
    expect(oct).toMatchObject({ knownAmount: 420, projectedFixed: 0, expectedAmount: 420 });
  });

  it('tells the month plan when and from which bank account it is charged', () => {
    const db = setup();
    const p = monthPlan(db, {}, { cycleKey: '2026-10', asOf: '2026-09-30' });
    expect(p.commitments.find(c => c.name === 'טניס')).toMatchObject({ method: 'card', payingAccountId: 'leumi:1', chargeDate: '2026-11-02' });
  });
});

describe('alerts', () => {
  it('flags duplicate charges and anomalies', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    const since = '2026-09-01';
    const a = addTx(db, { account: 'max:1', date: '2026-09-10', description: 'SUPER-PHARM 12', amount: -89.9, kind: 'expense' });
    const b = addTx(db, { account: 'max:1', date: '2026-09-11', description: 'SUPER-PHARM 34', amount: -89.9, kind: 'expense' });
    for (const [d, amt] of [['2026-05-01', -40], ['2026-06-01', -45], ['2026-07-01', -42], ['2026-08-01', -41]] as const) {
      addTx(db, { account: 'max:1', date: d, description: 'פז', amount: amt, kind: 'expense' });
    }
    const big = addTx(db, { account: 'max:1', date: '2026-09-15', description: 'פז', amount: -390, kind: 'expense' });
    const txs = loadTransactions(db);
    expect(findDuplicateCharges(txs, since).map(([x, y]) => [x.id, y.id])).toEqual([[a, b]]);
    expect(findAnomalies(txs, since).map(x => x.tx.id)).toEqual([big]);
  });
});

describe('paybacks', () => {
  it('matches a Bit payback to a shared expense and nets it out of spend', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    addAccount(db, 'hapoalim:1', 'bank');
    const dinner = addTx(db, { account: 'max:1', date: '2026-09-10', description: 'מסעדה', amount: -600, kind: 'expense' });
    const bit = addTx(db, { account: 'hapoalim:1', date: '2026-09-12', description: 'הפועלים-ביט', amount: 200, kind: 'income' });
    const [s] = findPaybackCandidates(loadTransactions(db), new Set());
    expect(s).toMatchObject({ inflowId: bit, expenseId: dinner, type: 'payback', amount: 200 });

    db.prepare(`INSERT INTO transaction_links (from_txn_id, to_txn_id, type, amount, status) VALUES (?, ?, 'payback', 200, 'confirmed')`).run(bit, dinner);
    const txs = loadTransactions(db);
    expect(spendOf(txs.find(t => t.id === dinner)!)).toBe(400);
    const summary = summarizeCycle(txs, { key: '2026-09', start: '2026-09-01', end: '2026-09-30' });
    expect(summary.income).toBe(0);
    expect(summary.spend).toBe(400);
  });
});

describe('recurring and business share', () => {
  it('detects a monthly subscription', () => {
    const db = testDb();
    addAccount(db, 'isracard:1', 'card');
    for (const m of ['06', '07', '08', '09']) addTx(db, { account: 'isracard:1', date: `2026-${m}-03`, description: 'NETFLIX COM', amount: -64.9, kind: 'expense' });
    const series = detectRecurring(loadTransactions(db), '2026-09-20');
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ kind: 'subscription', typicalAmount: 64.9, typicalDay: 3 });
  });

  it('keeps the business share out of household spend', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    const biz = Number(db.prepare(`INSERT INTO businesses (name) VALUES ('b')`).run().lastInsertRowid);
    const id = addTx(db, { account: 'max:1', date: '2026-09-10', description: 'פרטנר', amount: -200, kind: 'expense' });
    db.prepare(`UPDATE transactions SET business_id = ?, business_share_pct = 25 WHERE id = ?`).run(biz, id);
    const s = summarizeCycle(loadTransactions(db), { key: '2026-09', start: '2026-09-01', end: '2026-09-30' });
    expect(s.spend).toBe(150);
    expect(s.byBusiness[biz].spend).toBe(50);
  });
});

describe('fx', () => {
  it('converts with the latest rate on or before the date', () => {
    const db = testDb();
    setRate(db, '2026-09-01', 'USD', 3.6);
    setRate(db, '2026-09-20', '$', 3.7);
    expect(toIls(db, 100, 'USD', '2026-09-10')).toBeCloseTo(360);
    expect(toIls(db, 100, 'USD', '2026-09-25')).toBeCloseTo(370);
    expect(toIls(db, 100, '₪', '2026-09-25')).toBe(100);
  });
});

describe('month plan', () => {
  it('splits the month into fixed commitments, installments and variable spend', () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    addAccount(db, 'max:1', 'card');
    const ins = db.prepare(`INSERT INTO scheduled_items (name, kind, amount, day_of_month, bank_account_id, card_account_id, match_pattern, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`);
    ins.run('מסלול א', 'mortgage', -3000, 15, 'leumi:1', null, 'לאומי למשכנת');
    ins.run('מסלול ב', 'mortgage', -1000, 15, 'leumi:1', null, 'לאומי למשכנת');
    ins.run('גן', 'fixed_expense', -1500, 10, null, 'max:1', 'גני השקד');
    addTx(db, { account: 'leumi:1', date: '2026-09-14', description: 'לאומי למשכנת-י', amount: -4000, kind: 'expense' });
    // two children, two charges
    addTx(db, { account: 'max:1', date: '2026-09-09', description: 'גני השקד חינוך', amount: -1000, kind: 'expense' });
    addTx(db, { account: 'max:1', date: '2026-09-09', description: 'גני השקד חינוך', amount: -500, kind: 'expense' });
    addTx(db, { account: 'max:1', date: '2026-09-12', description: 'רמי לוי', amount: -700, kind: 'expense' });
    addTx(db, { account: 'max:1', date: '2026-08-10', processedDate: '2026-09-10', description: 'ELECTRO STORE', amount: -400,
      txnType: 'installments', installmentNumber: 2, installmentTotal: 3, kind: 'expense' });

    const p = monthPlan(db, {}, { cycleKey: '2026-09', asOf: '2026-09-20' });
    const by = (name: string) => p.commitments.find(c => c.name === name)!;
    expect([by('מסלול א').actual, by('מסלול ב').actual]).toEqual([3000, 1000]);
    expect(by('גן')).toMatchObject({ method: 'card', actual: 1500, state: 'paid' });
    expect(p.fixed).toMatchObject({ expected: 5500, paid: 5500, remaining: 0 });
    expect(p.installments.total).toBe(400);
    expect(p.variableSpent).toBe(700);
    // the kindergarten charges count as fixed everywhere, the supermarket doesn't
    const txs = loadTransactions(db);
    expect(txs.filter(t => t.fixed).map(t => t.description).sort()).toEqual(['גני השקד חינוך', 'גני השקד חינוך', 'לאומי למשכנת-י']);
  });
});
