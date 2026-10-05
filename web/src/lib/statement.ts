/**
 * Reading a bank / card statement exported from the bank's website (Excel or CSV): find the header
 * row, guess which column is what, and turn the rows into transactions. Pure functions — the file is
 * parsed in the browser, so it never leaves the computer except to the local API.
 */

export type Cell = string | number | boolean | Date | null | undefined;
export type Field = 'date' | 'processedDate' | 'description' | 'amount' | 'debit' | 'credit' | 'originalAmount' | 'currency' | 'memo' | 'installments';
export type Mapping = Partial<Record<Field, number>>;

export interface StatementRow {
  date: string; processedDate: string | null; description: string; amount: number;
  originalAmount: number | null; currency: string | null; memo: string | null;
  installmentNumber: number | null; installmentTotal: number | null;
}

export const FIELD_LABELS: Record<Field, string> = {
  date: 'תאריך עסקה', processedDate: 'תאריך חיוב', description: 'תיאור / בית עסק', amount: 'סכום (עמודה אחת)',
  debit: 'חובה (הוצאה)', credit: 'זכות (הכנסה)', originalAmount: 'סכום מקורי', currency: 'מטבע', memo: 'הערות', installments: 'תשלומים',
};

// header words per field, most specific first (checked in this order, so "תאריך חיוב" wins over "תאריך")
const HINTS: [Field, RegExp][] = [
  ['processedDate', /תאריך\s*חיוב|מועד\s*חיוב|תאריך\s*ערך|charge\s*date|value\s*date/i],
  ['date', /תאריך|date/i],
  ['debit', /^\s*(ב?חובה|משיכה|חיוב(?!\s*ב)|debit)\s*$/i],
  ['credit', /^\s*(ב?זכות|הפקדה|זיכוי|credit)\s*$/i],
  ['amount', /סכום\s*(ה?חיוב|לחיוב)|סכום\s*בש"ח|charged|^\s*סכום\s*$|^\s*amount\s*$/i],
  ['originalAmount', /סכום\s*(ה?עסקה|מקורי)|original/i],
  ['currency', /מטבע|currency/i],
  ['installments', /תשלום|installment/i],
  ['description', /בית\s*(ה)?עסק|תיאור|תאור|פרטים|הפעולה|description|merchant/i],
  ['memo', /הערות|פירוט|אסמכתא|memo|notes/i],
];

const text = (c: Cell) => (c == null ? '' : c instanceof Date ? c.toISOString() : String(c)).trim();

/** Guess columns from one header row. */
export function guessMapping(header: Cell[]): Mapping {
  const m: Mapping = {};
  header.forEach((cell, col) => {
    const h = text(cell);
    if (!h) return;
    const hit = HINTS.find(([field, re]) => m[field] == null && re.test(h));
    if (hit) m[hit[0]] = col;
  });
  // a lone "סכום עסקה" column is the amount
  if (m.amount == null && m.debit == null && m.originalAmount != null) { m.amount = m.originalAmount; delete m.originalAmount; }
  return m;
}

const usable = (m: Mapping) => m.date != null && m.description != null && (m.amount != null || m.debit != null || m.credit != null);

/** The header row: the first of the top rows whose cells look like date + description + amount headers. */
export function findHeader(rows: Cell[][]): { index: number; mapping: Mapping } | null {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const mapping = guessMapping(rows[i]);
    if (usable(mapping)) return { index: i, mapping };
  }
  return null;
}

/** dd/mm/yyyy, dd.mm.yy, yyyy-mm-dd, an Excel serial number or a Date → yyyy-mm-dd. */
export function parseDate(c: Cell): string | null {
  if (c instanceof Date && !Number.isNaN(c.getTime())) {
    // SheetJS dates are local midnight; read them back in local time
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
  }
  if (typeof c === 'number' && c > 20000 && c < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(c) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = text(c);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}
function valid(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,234.50", "₪ -45", "(120.00)", "45-" → number; empty → null. */
export function parseAmount(c: Cell): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  let s = text(c).replace(/[₪$€£,\s]|ש"ח|NIS|ILS|USD|EUR/gi, '');
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

const CURRENCY: Record<string, string> = { '₪': 'ILS', 'ש"ח': 'ILS', 'שח': 'ILS', 'nis': 'ILS', '$': 'USD', 'דולר': 'USD', '€': 'EUR', 'אירו': 'EUR', 'יורו': 'EUR', '£': 'GBP' };
function parseCurrency(c: Cell): string | null {
  const s = text(c);
  if (!s) return null;
  if (/^[A-Z]{3}$/i.test(s)) return s.toUpperCase();
  return CURRENCY[s.toLowerCase()] ?? null;
}

/**
 * Turn the rows under the header into transactions. Expenses come out negative (the scrapers' sign).
 * `expensesPositive`: a single amount column where purchases are positive (credit card statements).
 * Rows without a date or an amount (totals, blank lines, section titles) are skipped.
 */
export function toTransactions(rows: Cell[][], headerIndex: number, m: Mapping, expensesPositive: boolean): { rows: StatementRow[]; skipped: number } {
  const out: StatementRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerIndex + 1)) {
    if (!r.some(c => text(c))) continue;
    const date = m.date != null ? parseDate(r[m.date]) : null;
    const description = m.description != null ? text(r[m.description]) : '';
    let amount: number | null = null;
    if (m.amount != null) {
      const a = parseAmount(r[m.amount]);
      amount = a == null ? null : expensesPositive ? -a : a;
    } else {
      const debit = m.debit != null ? parseAmount(r[m.debit]) : null;
      const credit = m.credit != null ? parseAmount(r[m.credit]) : null;
      if (debit != null || credit != null) amount = (credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (!date || !description || amount == null || amount === 0) { skipped++; continue; }

    const original = m.originalAmount != null ? parseAmount(r[m.originalAmount]) : null;
    // "תשלום 2 מתוך 6" — in its own column, or in the notes (Max, Cal)
    const instText = [m.installments, m.memo].map(col => (col != null ? text(r[col]) : '')).join(' ');
    const found = instText.match(/(\d+)\s*(?:מתוך|\/)\s*(\d+)/);
    const inst = found && +found[1] >= 1 && +found[1] <= +found[2] && +found[2] <= 60 ? found : null;
    out.push({
      date,
      processedDate: m.processedDate != null ? parseDate(r[m.processedDate]) : null,
      description,
      amount: Math.round(amount * 100) / 100,
      originalAmount: original == null ? null : Math.round((Math.sign(amount) || -1) * Math.abs(original) * 100) / 100,
      currency: m.currency != null ? parseCurrency(r[m.currency]) : null,
      memo: m.memo != null ? text(r[m.memo]) || null : null,
      installmentNumber: inst ? Number(inst[1]) : null,
      installmentTotal: inst ? Number(inst[2]) : null,
    });
  }
  return { rows: out, skipped };
}
