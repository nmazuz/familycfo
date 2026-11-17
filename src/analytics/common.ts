import type { DB } from '../db/connection.js';
import { localDate } from '../ingest/normalize.js';
import { normalizeCurrency, rateToIls } from './fx.js';

export const SHARED_MEMBER_ID = 3;

export interface Tx {
  id: number;
  accountId: string;
  /** 'manual' = entered by hand (cash, paid by someone else…) — counts as spend, not part of any balance */
  accountKind: 'bank' | 'card' | 'manual';
  company: string;
  billingBankAccountId: string | null;
  /** purchase date in Israel, YYYY-MM-DD */
  date: string;
  /** charge/value date in Israel, YYYY-MM-DD (falls back to date) */
  processedDate: string;
  /** date used for spend/budget views: charge date for installments, purchase date otherwise */
  effectiveDate: string;
  description: string;
  merchant: string;
  /** signed ILS amount of the whole transaction */
  amount: number;
  /** portion that belongs to the household (amount minus the business share) */
  personalAmount: number;
  /** portion assigned to a business */
  businessAmount: number;
  kind: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: string | null;
  /** parent of the category (null when it is top-level) */
  categoryParentId: number | null;
  categoryParentName: string | null;
  fixed: boolean;
  discretionary: boolean;
  memberId: number;
  businessId: number | null;
  status: string | null;
  txnType: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  tagIds: number[];
  /** confirmed payback/refund amounts linked to this expense (positive) */
  paybackTotal: number;
  /** this inflow is linked to an expense, so it offsets that expense instead of counting as income */
  linkedInflow: boolean;
  categorySource: string | null;
  notes: string | null;
  followUp: boolean;
  scrapeBatchId: number | null;
  /** bank row → the card purchase it settles (immediate debit) */
  matchedTxnId: number | null;
  /** card purchase → the bank row that already charged it (immediate debit) */
  settledByTxnId: number | null;
  /** the card charges each purchase to the bank right away instead of a monthly statement */
  accountIsDebit: boolean;
  bankIdentifier: string | null;
}

/** Transfers and card-bill payments move money between own accounts — never income or spend. */
export const NON_SPEND_KINDS = new Set(['transfer', 'card_payment', 'savings']);

/**
 * Merchant key for grouping: lowercase, drop tokens containing digits (transaction codes like
 * "A1B2C3D4E5") and punctuation, so "FACEBK A1B2C3D4E5" and "FACEBK F6G7H8J9K0" group together.
 */
export interface CommitmentMatcher { id: number; accountId: string; pattern: string; matches: (accountId: string, description: string) => boolean }

/** Confirmed fixed commitments (scheduled expenses, loans, mortgage — on a bank account or paid by card). */
export function commitmentMatchers(db: DB, statuses: string[] = ['confirmed']): CommitmentMatcher[] {
  const rows = db.prepare(`SELECT id, name, match_pattern, COALESCE(card_account_id, bank_account_id) AS account_id FROM scheduled_items
    WHERE kind IN ('fixed_expense','loan','mortgage') AND status IN (${statuses.map(() => '?').join(',')})
      AND COALESCE(card_account_id, bank_account_id) IS NOT NULL`).all(...statuses) as
    { id: number; name: string; match_pattern: string | null; account_id: string }[];
  return rows.map(r => {
    const pattern = (r.match_pattern?.trim() || merchantKey(r.name)).toLowerCase();
    return {
      id: r.id, accountId: r.account_id, pattern,
      matches: (accountId: string, description: string) => accountId === r.account_id
        && (merchantKey(description).includes(pattern) || description.toLowerCase().includes(pattern)),
    };
  });
}

export function merchantKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[*"'`.,()\-_/\\|#]+/g, ' ')
    .split(/\s+/)
    .filter(tok => tok && !/\d/.test(tok))
    .join(' ')
    .trim() || description.trim().toLowerCase();
}

export interface LoadOptions {
  /** inclusive YYYY-MM-DD on effectiveDate */
  from?: string;
  to?: string;
  includeExcluded?: boolean;
}

export function loadTransactions(db: DB, opts: LoadOptions = {}): Tx[] {
  const rows = db.prepare(`
    SELECT t.*, a.kind AS account_kind, a.company, a.owner_member_id, a.billing_bank_account_id, a.is_debit,
      c.name AS category_name, c.kind AS category_kind, c.default_fixed, c.discretionary,
      c.parent_id AS category_parent_id, p.name AS category_parent_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    ${opts.includeExcluded ? '' : 'WHERE t.excluded = 0'}
  `).all() as Record<string, any>[];

  const tagRows = db.prepare(`SELECT transaction_id, tag_id FROM transaction_tags`).all() as { transaction_id: number; tag_id: number }[];
  const tags = new Map<number, number[]>();
  for (const r of tagRows) tags.set(r.transaction_id, [...(tags.get(r.transaction_id) ?? []), r.tag_id]);

  const links = db.prepare(`SELECT from_txn_id, to_txn_id, amount FROM transaction_links WHERE status = 'confirmed'`).all() as
    { from_txn_id: number; to_txn_id: number; amount: number }[];
  const paybacks = new Map<number, number>();
  const linkedInflows = new Set<number>();
  for (const l of links) {
    paybacks.set(l.to_txn_id, (paybacks.get(l.to_txn_id) ?? 0) + Math.abs(l.amount));
    linkedInflows.add(l.from_txn_id);
  }

  const settledBy = new Map<number, number>();
  for (const r of rows) if (r.matched_txn_id != null) settledBy.set(r.matched_txn_id, r.id);
  // a debit card's purchases are paid from the bank account its bank rows were found on
  const accountOfRow = new Map(rows.map(r => [r.id as number, r.account_id as string]));
  const debitPayer = new Map<string, string>();
  for (const r of rows) {
    const cardAccount = r.matched_txn_id != null ? accountOfRow.get(r.matched_txn_id) : undefined;
    if (cardAccount) debitPayer.set(cardAccount, r.account_id);
  }

  // the household's fixed commitments (the list in "קבועות החודש"): a matching payment is fixed
  const commitments = commitmentMatchers(db);

  const txs: Tx[] = [];
  for (const r of rows) {
    const date = localDate(r.date);
    const processedDate = r.processed_date ? localDate(r.processed_date) : date;
    const effectiveDate = r.txn_type === 'installments' ? processedDate : date;
    if (opts.from && effectiveDate < opts.from) continue;
    if (opts.to && effectiveDate > opts.to) continue;

    const rate = rateToIls(db, normalizeCurrency(r.charged_currency), processedDate) ?? 1;
    const amount = r.charged_amount * rate;
    const share = r.business_id ? Math.min(100, Math.max(0, r.business_share_pct ?? 100)) / 100 : 0;
    const merchant = merchantKey(r.description);
    const fixed = r.fixed_override != null
      ? !!r.fixed_override
      : (r.charged_amount < 0 && commitments.some(c => c.matches(r.account_id, r.description))) || !!r.default_fixed;

    txs.push({
      id: r.id,
      accountId: r.account_id,
      accountKind: r.account_kind,
      company: r.company,
      billingBankAccountId: r.billing_bank_account_id ?? debitPayer.get(r.account_id) ?? null,
      date,
      processedDate,
      effectiveDate,
      description: r.description,
      merchant,
      amount,
      personalAmount: amount * (1 - share),
      businessAmount: amount * share,
      kind: r.kind ?? (amount < 0 ? 'expense' : 'income'),
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryKind: r.category_kind,
      categoryParentId: r.category_parent_id ?? null,
      categoryParentName: r.category_parent_name ?? null,
      fixed,
      discretionary: r.discretionary == null ? true : !!r.discretionary && !fixed,
      memberId: r.member_id ?? r.owner_member_id ?? SHARED_MEMBER_ID,
      businessId: r.business_id,
      status: r.status,
      txnType: r.txn_type,
      installmentNumber: r.installment_number,
      installmentTotal: r.installment_total,
      tagIds: tags.get(r.id) ?? [],
      paybackTotal: paybacks.get(r.id) ?? 0,
      linkedInflow: linkedInflows.has(r.id),
      categorySource: r.category_source,
      notes: r.notes,
      followUp: !!r.follow_up,
      scrapeBatchId: r.scrape_batch_id ?? null,
      matchedTxnId: r.matched_txn_id ?? null,
      settledByTxnId: settledBy.get(r.id) ?? null,
      accountIsDebit: !!r.is_debit,
      bankIdentifier: r.bank_identifier ?? null,
    });
  }
  return txs;
}

export interface TxFilter {
  memberId?: number;
  businessId?: number;
  tagIds?: number[];
  categoryId?: number;
  accountId?: string;
  search?: string;
}

export function filterTx(txs: Tx[], f: TxFilter): Tx[] {
  const q = f.search?.trim().toLowerCase();
  return txs.filter(t =>
    (f.memberId == null || t.memberId === f.memberId) &&
    (f.businessId == null || t.businessId === f.businessId) &&
    (!f.tagIds?.length || f.tagIds.every(id => t.tagIds.includes(id))) &&
    // a parent category includes its sub-categories
    (f.categoryId == null || t.categoryId === f.categoryId || t.categoryParentId === f.categoryId) &&
    (f.accountId == null || t.accountId === f.accountId) &&
    (!q || t.description.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q)));
}

/** Household spend of one row, net of confirmed paybacks (positive number, 0 for non-spend). */
export function spendOf(t: Tx): number {
  if (t.kind !== 'expense') return 0;
  return Math.max(0, -t.personalAmount - t.paybackTotal * (t.personalAmount / (t.amount || 1)));
}

/** Household income of one row (positive), excluding linked paybacks. */
export function incomeOf(t: Tx): number {
  if (t.linkedInflow) return 0;
  if (t.kind === 'income') return Math.max(0, t.personalAmount);
  return 0;
}

/** Refunds reduce spend in their category. */
export function refundOf(t: Tx): number {
  return t.kind === 'refund' && !t.linkedInflow ? Math.max(0, t.personalAmount) : 0;
}

// ---- dates & cycles --------------------------------------------------------------------

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Date for `day` in the given month, clamped to the month's length (31 → 30 Sep). */
export function dayInMonth(year: number, month0: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, d)).toISOString().slice(0, 10);
}

export interface Cycle {
  /** label: YYYY-MM of the month the cycle starts in */
  key: string;
  start: string;
  end: string;
}

/** The household cycle containing `date`, e.g. start day 10 → 10 Sep .. 9 Oct. */
export function cycleFor(date: string, startDay = 1): Cycle {
  let y = Number(date.slice(0, 4));
  let m = Number(date.slice(5, 7)) - 1;
  if (Number(date.slice(8, 10)) < Math.min(startDay, daysInMonth(y, m))) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return cycleStarting(y, m, startDay);
}

export function cycleStarting(year: number, month0: number, startDay = 1): Cycle {
  const start = dayInMonth(year, month0, startDay);
  const nextY = month0 === 11 ? year + 1 : year;
  const nextM = (month0 + 1) % 12;
  return { key: `${year}-${String(month0 + 1).padStart(2, '0')}`, start, end: addDays(dayInMonth(nextY, nextM, startDay), -1) };
}

/** The date of day-of-month `day` inside the cycle (a cycle can span two calendar months). */
export function dateInCycle(cycle: Cycle, day: number): string {
  for (const month of [cycle.start, cycle.end]) {
    const date = dayInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, day);
    if (date >= cycle.start && date <= cycle.end) return date;
  }
  return cycle.end;
}

export function cycleByKey(key: string, startDay = 1): Cycle {
  return cycleStarting(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, startDay);
}

/** The n cycles ending with (and including) the cycle containing `date`, oldest first. */
export function recentCycles(date: string, n: number, startDay = 1): Cycle[] {
  const current = cycleFor(date, startDay);
  const out: Cycle[] = [current];
  for (let i = 1; i < n; i++) out.unshift(cycleFor(addDays(out[0].start, -1), startDay));
  return out;
}

export function getSetting(db: DB, key: string, fallback: string): string {
  return (db.prepare(`SELECT value FROM settings WHERE key = ?`).pluck().get(key) as string | undefined) ?? fallback;
}

export const cycleStartDay = (db: DB) => Number(getSetting(db, 'cycle_start_day', '1')) || 1;

// ---- stats ------------------------------------------------------------------------------

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map(v => Math.abs(v - m)));
}

/** Mean after dropping the highest and lowest value (when there are at least 4). */
export function trimmedMean(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const kept = s.length >= 4 ? s.slice(1, -1) : s;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
