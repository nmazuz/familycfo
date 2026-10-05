import { describe, expect, it } from 'vitest';
import { findHeader, parseAmount, parseDate, toTransactions } from '../web/src/lib/statement';

describe('statement file parsing', () => {
  it('reads dates and amounts in the formats bank exports use', () => {
    expect(parseDate('05/10/2026')).toBe('2026-10-05');
    expect(parseDate('5.1.26')).toBe('2026-01-05');
    expect(parseDate('2026-03-09')).toBe('2026-03-09');
    expect(parseDate(46300)).toBe('2026-10-05');
    expect(parseDate('סה"כ')).toBeNull();
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('₪ -45')).toBe(-45);
    expect(parseAmount('(120.00)')).toBe(-120);
    expect(parseAmount('45-')).toBe(-45);
    expect(parseAmount('')).toBeNull();
  });

  it('finds the header under title rows and reads a card statement (purchases positive)', () => {
    const rows = [
      ['פירוט עסקאות לכרטיס 1234'],
      [],
      ['תאריך עסקה', 'שם בית העסק', 'קטגוריה', 'סכום עסקה', 'מטבע', 'סכום חיוב', 'הערות', 'תאריך חיוב'],
      ['01/09/2026', 'שופרסל', 'מזון', '250.40', '₪', '250.40', '', '10/10/2026'],
      ['03/09/2026', 'KSP', 'מחשבים', '1,200', '₪', '400', 'תשלום 1 מתוך 3', '10/10/2026'],
      ['04/09/2026', 'זיכוי', '', '-50', '₪', '-50', '', '10/10/2026'],
      ['', 'סה"כ', '', '', '', '600.40', '', ''],
    ];
    const header = findHeader(rows)!;
    expect(header.index).toBe(2);
    expect(header.mapping).toMatchObject({ date: 0, description: 1, originalAmount: 3, currency: 4, amount: 5, memo: 6, processedDate: 7 });
    const { rows: tx, skipped } = toTransactions(rows, header.index, header.mapping, true);
    expect(skipped).toBe(1);
    expect(tx).toHaveLength(3);
    expect(tx[0]).toMatchObject({ date: '2026-09-01', processedDate: '2026-10-10', description: 'שופרסל', amount: -250.4, currency: 'ILS' });
    expect(tx[1]).toMatchObject({ amount: -400, originalAmount: -1200, installmentNumber: 1, installmentTotal: 3 });
    expect(tx[2].amount).toBe(50);
  });

  it('reads a bank statement with debit / credit columns', () => {
    const rows = [
      ['תאריך', 'תיאור הפעולה', 'אסמכתא', 'חובה', 'זכות', 'יתרה'],
      ['02/09/2026', 'משכורת', '111', '', '15,000.00', '20,000'],
      ['03/09/2026', 'הוראת קבע חשמל', '112', '420.10', '', '19,579.90'],
    ];
    const header = findHeader(rows)!;
    expect(header.mapping).toMatchObject({ date: 0, description: 1, debit: 3, credit: 4 });
    const { rows: tx } = toTransactions(rows, header.index, header.mapping, false);
    expect(tx.map(t => t.amount)).toEqual([15000, -420.1]);
  });
});
