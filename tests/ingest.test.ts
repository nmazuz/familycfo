import { describe, expect, it } from 'vitest';
import { legacyIdentifier, normalizeTransactions, type ScrapedTransaction } from '../src/ingest/normalize.js';
import { saveTransactions } from '../src/db/ingestRepo.js';
import { applyRules, deriveKinds, findCategory, getOrCreateCategory, kindFor } from '../src/ingest/classify.js';
import { openDb } from '../src/db/connection.js';
import { matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from '../src/ingest/transfers.js';
import { addAccount, addTx, testDb } from './helpers.js';

const scraped = (over: Partial<ScrapedTransaction> = {}): ScrapedTransaction => ({
  type: 'normal' as ScrapedTransaction['type'],
  date: '2026-09-01T21:00:00.000Z',
  processedDate: '2026-10-02T21:00:00.000Z',
  originalAmount: -18,
  originalCurrency: 'ILS',
  chargedAmount: -18,
  description: 'ארומה',
  status: 'completed' as ScrapedTransaction['status'],
  ...over,
});

describe('normalizeTransactions identity', () => {
  it('keeps two identical purchases on the same day', () => {
    const [a, b] = normalizeTransactions('isracard:1', [scraped(), scraped()]);
    expect(a.identifier).not.toBe(b.identifier);
    // the first keeps the pre-migration identifier so old rows still match
    expect(a.identifier).toBe(legacyIdentifier('isracard:1', a.date, 'ארומה', -18, 'ILS'));
  });

  it('skips rows whose amount is not a number (Mizrahi pending income rows)', () => {
    const rows = normalizeTransactions('mizrahi:1', [scraped({ originalAmount: NaN, chargedAmount: NaN }), scraped()]);
    expect(rows).toHaveLength(1);
  });

  it('uses the bank reference plus installment number when available', () => {
    const one = normalizeTransactions('max:1', [scraped({ identifier: 'A1', installments: { number: 1, total: 3 } })])[0];
    const two = normalizeTransactions('max:1', [scraped({ identifier: 'A1', installments: { number: 2, total: 3 } })])[0];
    expect(one.identifier).not.toBe(two.identifier);
    expect(one.bankIdentifier).toBe('A1');
  });

  it('is stable across scrapes', () => {
    const first = normalizeTransactions('max:1', [scraped(), scraped({ description: 'x' })]).map(t => t.identifier);
    const second = normalizeTransactions('max:1', [scraped(), scraped({ description: 'x' })]).map(t => t.identifier);
    expect(second).toEqual(first);
  });
});

describe('saveTransactions', () => {
  it('re-scraping inserts nothing new and fills bank fields on legacy rows', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    // a row saved by the old code: legacy identifier, no bank reference / charge date
    const legacy = legacyIdentifier('max:1', '2026-09-01T21:00:00.000Z', 'ארומה', -18, 'ILS');
    db.prepare(`INSERT INTO transactions (identifier, account_id, date, description, original_amount, original_currency, charged_amount)
      VALUES (?, 'max:1', '2026-09-01T21:00:00.000Z', 'ארומה', -18, 'ILS', -18)`).run(legacy);

    const txns = normalizeTransactions('max:1', [scraped({ identifier: 'REF9' })]);
    expect(saveTransactions(db, txns)).toEqual({ insertedIds: [], updated: 1 });
    const row = db.prepare(`SELECT bank_identifier, processed_date FROM transactions`).get() as Record<string, string>;
    expect(row.bank_identifier).toBe('REF9');
    expect(row.processed_date).toBe('2026-10-02T21:00:00.000Z');

    expect(saveTransactions(db, normalizeTransactions('max:1', [scraped({ identifier: 'REF9' })])).insertedIds).toEqual([]);
    expect(db.prepare(`SELECT COUNT(1) FROM transactions`).pluck().get()).toBe(1);
  });

  it('turns a pending row into the completed one instead of duplicating it', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    saveTransactions(db, normalizeTransactions('max:1', [scraped({ status: 'pending' as ScrapedTransaction['status'], chargedAmount: 0 })]));
    const res = saveTransactions(db, normalizeTransactions('max:1', [scraped({ identifier: 'R1' })]));
    expect(res.updated).toBe(1);
    expect(db.prepare(`SELECT status, charged_amount FROM transactions`).get()).toEqual({ status: 'completed', charged_amount: -18 });
  });
});

describe('kinds, card bills and transfers', () => {
  it('derives kinds', () => {
    expect(kindFor({ description: 'כאל', charged_amount: -5000, account_kind: 'bank', category_kind: null })).toBe('card_payment');
    expect(kindFor({ description: 'כאלבו', charged_amount: -50, account_kind: 'bank', category_kind: null })).toBe('expense');
    expect(kindFor({ description: 'הו"ק לחיסכון', charged_amount: -300, account_kind: 'bank', category_kind: null })).toBe('savings');
    expect(kindFor({ description: 'זיכוי', charged_amount: 40, account_kind: 'card', category_kind: null })).toBe('refund');
    expect(kindFor({ description: 'משכורת', charged_amount: 9000, account_kind: 'bank', category_kind: null })).toBe('income');
  });

  it('keeps statement bills that a scraped card explains and demotes debit purchases', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'visaCal:1', 'card', 1, 'hapoalim:1');
    addTx(db, { account: 'visaCal:1', date: '2026-08-20', processedDate: '2026-09-14', description: 'a', amount: -300 });
    addTx(db, { account: 'visaCal:1', date: '2026-08-25', processedDate: '2026-09-14', description: 'b', amount: -200 });
    const bill = addTx(db, { account: 'hapoalim:1', date: '2026-09-14', description: 'כאל', amount: -500 });
    const debit = addTx(db, { account: 'hapoalim:1', date: '2026-09-03', description: 'ויזה', amount: -45.9 });
    deriveKinds(db, 'all');
    expect(reconcileCardBills(db)).toEqual({ kept: 1, demoted: 1 });
    const kind = (id: number) => db.prepare(`SELECT kind FROM transactions WHERE id = ?`).pluck().get(id);
    expect(kind(bill)).toBe('card_payment');
    expect(kind(debit)).toBe('expense');
  });

  it('pairs immediate debit-card charges one-to-one with the card purchases', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'isracard:1', 'card');
    const buy = addTx(db, { account: 'isracard:1', date: '2026-09-27', description: 'SOME SAAS IO', amount: -23.9, kind: 'expense' });
    const ads = [21, 23, 25].map(d => addTx(db, { account: 'isracard:1', date: `2026-07-${d}`, description: 'FACEBK X', amount: -79, kind: 'expense' }));
    const bankBuy = addTx(db, { account: 'hapoalim:1', date: '2026-09-28', description: 'ויזה', amount: -23.9, kind: 'expense' });
    const bankAd = addTx(db, { account: 'hapoalim:1', date: '2026-07-25', description: 'ויזה', amount: -79, kind: 'expense' });
    const unrelated = addTx(db, { account: 'hapoalim:1', date: '2026-09-28', description: 'ויזה', amount: -61, kind: 'expense' });

    const res = matchImmediateCardDebits(db);
    expect(res.matched).toBe(2);
    const row = (id: number) => db.prepare(`SELECT kind, matched_txn_id FROM transactions WHERE id = ?`).get(id);
    expect(row(bankBuy)).toEqual({ kind: 'card_payment', matched_txn_id: buy });
    // the ₪79 bank row settles exactly one ad — the closest one on or before it (25 Jul)
    expect(row(bankAd)).toEqual({ kind: 'card_payment', matched_txn_id: ads[2] });
    expect(row(unrelated)).toEqual({ kind: 'expense', matched_txn_id: null });
  });

  it('pairs transfers between own accounts', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'leumi:1', 'bank');
    const out = addTx(db, { account: 'hapoalim:1', date: '2026-02-09', description: "העב' לאחר-נייד", amount: -9600, kind: 'expense' });
    const inn = addTx(db, { account: 'leumi:1', date: '2026-02-09', description: 'בנק הפועלים', amount: 9600, kind: 'income' });
    const other = addTx(db, { account: 'leumi:1', date: '2026-02-09', description: 'משכורת', amount: 10850, kind: 'income' });
    expect(matchInternalTransfers(db)).toBe(1);
    const kind = (id: number) => db.prepare(`SELECT kind FROM transactions WHERE id = ?`).pluck().get(id);
    expect([kind(out), kind(inn), kind(other)]).toEqual(['transfer', 'transfer', 'income']);
  });

  it('applies rules but never overrides a manual category', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    const cat = Number(db.prepare(`INSERT INTO categories (name) VALUES ('פרסום')`).run().lastInsertRowid);
    const biz = Number(db.prepare(`INSERT INTO businesses (name) VALUES ('Acme')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO category_rules (match_type, pattern, set_category_id, set_business_id) VALUES ('contains', 'facebk', ?, ?)`).run(cat, biz);
    const a = addTx(db, { account: 'max:1', date: '2026-09-01', description: 'FACEBK A1B2C3D4E5', amount: -79 });
    const b = addTx(db, { account: 'max:1', date: '2026-09-02', description: 'FACEBK F6G7H8J9K0', amount: -79 });
    db.prepare(`UPDATE transactions SET category_id = NULL, category_source = 'manual' WHERE id = ?`).run(b);
    applyRules(db, 'all');
    const row = (id: number) => db.prepare(`SELECT category_id, business_id FROM transactions WHERE id = ?`).get(id);
    expect(row(a)).toEqual({ category_id: cat, business_id: biz });
    expect(row(b)).toEqual({ category_id: null, business_id: biz });
  });
});

describe('merged categories', () => {
  it('maps an old name from the categorizer to the category it was merged into', () => {
    const db = testDb();
    const target = Number(db.prepare(`INSERT INTO categories (name) VALUES ('סופרמרקט')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO category_aliases (name, category_id) VALUES ('מזון וסופרמרקט', ?)`).run(target);
    const before = db.prepare(`SELECT COUNT(1) FROM categories`).pluck().get();
    expect(getOrCreateCategory(db, 'מזון וסופרמרקט')).toBe(target);
    expect(db.prepare(`SELECT COUNT(1) FROM categories`).pluck().get()).toBe(before);
  });

  it('matches a rule saved as a merchant key against the raw description', () => {
    const db = testDb();
    addAccount(db, 'bank:1', 'bank');
    const cat = Number(db.prepare(`INSERT INTO categories (name) VALUES ('מים')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO category_rules (match_type, pattern, set_category_id) VALUES ('contains', 'תאגיד המים בע י', ?)`).run(cat);
    const id = addTx(db, { account: 'bank:1', date: '2026-09-10', description: 'תאגיד המים בע"-י', amount: -250, kind: 'expense' });
    applyRules(db, [id]);
    expect(db.prepare(`SELECT category_id FROM transactions WHERE id = ?`).pluck().get(id)).toBe(cat);
  });
});

describe('re-scrape with a renumbered reference', () => {
  it('updates the existing row instead of adding a duplicate, and keeps two identical same-day rows', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    const salary = (ref: string) => scraped({ identifier: ref, description: 'משכורת-נט', originalAmount: 18420.75, chargedAmount: 18420.75, processedDate: '2026-07-07T21:00:00.000Z', date: '2026-07-07T21:00:00.000Z' });
    const coffee = (ref: string) => scraped({ identifier: ref, description: 'ארומה', originalAmount: -18, chargedAmount: -18, date: '2026-07-09T21:00:00.000Z' });
    saveTransactions(db, normalizeTransactions('hapoalim:1', [salary('5550001234'), coffee('111'), coffee('112')]));
    const second = saveTransactions(db, normalizeTransactions('hapoalim:1', [salary('400123'), coffee('901'), coffee('902')]));
    expect(second.insertedIds).toEqual([]);
    expect(db.prepare(`SELECT COUNT(1) FROM transactions`).pluck().get()).toBe(3);
  });
});

describe('a new database', () => {
  it('starts with the default categories and the card companies\' category names as aliases', () => {
    const db = openDb(':memory:');
    const count = db.prepare(`SELECT COUNT(*) FROM categories`).pluck().get() as number;
    expect(count).toBeGreaterThan(50);
    const supermarket = db.prepare(`SELECT id FROM categories WHERE name = 'סופרמרקט'`).pluck().get();
    expect(findCategory(db, 'מזון וצריכה')).toBe(supermarket);
    expect(db.prepare(`SELECT kind FROM categories WHERE name = 'משכורת'`).pluck().get()).toBe('income');
  });
});
