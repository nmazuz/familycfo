import type { DB } from '../db/connection.js';
import { addDays, daysBetween, loadTransactions, mad, median, round, spendOf, today, type Tx } from './common.js';
import { budgetStatus } from './budgets.js';
import { buildForecast } from './forecast.js';
import { unmatchedCardBills, upcomingCardCharges } from './cards.js';
import { isOverdue, listPlanned } from './planned.js';

export interface AlertDraft {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  dedupeKey: string;
  title: string;
  message: string;
  txnIds?: number[];
  data?: unknown;
}

const ils = (n: number) => `₪${Math.round(Math.abs(n)).toLocaleString('he-IL')}`;
const FEE_PATTERN = /עמלה|עמלת|עמ'|דמי כרטיס|דמי ניהול|ריבית חובה/;

/** Same card, merchant and amount within 3 days, not installments. */
export function findDuplicateCharges(txs: Tx[], since: string): [Tx, Tx][] {
  const recent = txs.filter(t => t.kind === 'expense' && t.txnType !== 'installments' && t.date >= since && t.date <= today())
    .sort((a, b) => a.date.localeCompare(b.date));
  const pairs: [Tx, Tx][] = [];
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length && daysBetween(recent[i].date, recent[j].date) <= 3; j++) {
      const a = recent[i], b = recent[j];
      if (a.accountId === b.accountId && a.merchant === b.merchant && Math.abs(a.amount - b.amount) < 0.01 && Math.abs(a.amount) >= 20) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** Expenses far above what this merchant usually costs (median + 3×MAD, at least 1.5×). */
export function findAnomalies(txs: Tx[], since: string): { tx: Tx; typical: number }[] {
  const history = new Map<string, number[]>();
  for (const t of txs) {
    if (t.kind !== 'expense' || t.date >= since) continue;
    history.set(t.merchant, [...(history.get(t.merchant) ?? []), -t.amount]);
  }
  const out: { tx: Tx; typical: number }[] = [];
  for (const t of txs.filter(t => t.kind === 'expense' && t.date >= since && t.date <= today() && t.txnType !== 'installments')) {
    const past = history.get(t.merchant);
    if (!past || past.length < 4) continue;
    const m = median(past);
    const amount = -t.amount;
    if (amount > m + 3 * Math.max(mad(past), m * 0.1) && amount > m * 1.5 && amount - m > 50) out.push({ tx: t, typical: round(m) });
  }
  return out;
}

export function generateAlerts(db: DB, asOf = today()): AlertDraft[] {
  const txs = loadTransactions(db);
  const recentSince = addDays(asOf, -14);
  const drafts: AlertDraft[] = [];

  // budgets
  for (const b of budgetStatus(db, { asOf })) {
    if (b.budget == null || b.pct == null) continue;
    const level = b.pct >= 100 ? 100 : b.pct >= 80 ? 80 : 0;
    if (!level) continue;
    drafts.push({
      type: 'budget', severity: level === 100 ? 'critical' : 'warning',
      dedupeKey: `budget:${b.categoryId}:${b.memberId ?? 'h'}:${asOf.slice(0, 7)}:${level}`,
      title: level === 100 ? `חריגה מתקציב ${b.categoryName}` : `${b.pct}% מתקציב ${b.categoryName}`,
      message: `הוצאו ${ils(b.spent)} מתוך ${ils(b.budget)}. תחזית לסוף החודש: ${ils(b.projected)}.`,
      data: b,
    });
  }

  for (const [a, b] of findDuplicateCharges(txs, recentSince)) {
    drafts.push({
      type: 'duplicate', severity: 'warning', dedupeKey: `dup:${a.id}:${b.id}`,
      title: `חיוב כפול אפשרי: ${a.description}`,
      message: `${ils(a.amount)} ב-${a.date} ושוב ב-${b.date} באותו כרטיס.`, txnIds: [a.id, b.id],
    });
  }

  for (const { tx, typical } of findAnomalies(txs, recentSince)) {
    drafts.push({
      type: 'anomaly', severity: 'info', dedupeKey: `anomaly:${tx.id}`,
      title: `הוצאה גבוהה מהרגיל: ${tx.description}`,
      message: `${ils(tx.amount)} לעומת ${ils(typical)} בדרך כלל.`, txnIds: [tx.id],
    });
  }

  // subscriptions: new ones and price increases
  const series = db.prepare(`SELECT * FROM recurring_series WHERE active = 1 AND kind = 'subscription'`).all() as
    { merchant_key: string; account_id: string; typical_amount: number; last_amount: number; last_date: string }[];
  for (const s of series) {
    const rows = txs.filter(t => t.merchant === s.merchant_key && t.accountId === s.account_id).sort((a, b) => a.date.localeCompare(b.date));
    if (rows[0] && rows[0].date >= addDays(asOf, -100)) {
      drafts.push({ type: 'new_subscription', severity: 'info', dedupeKey: `newsub:${s.merchant_key}:${s.account_id}`,
        title: `מנוי חדש: ${rows[0].description}`, message: `${ils(s.typical_amount)} בחודש (${ils(s.typical_amount * 12)} בשנה).` });
    }
    if (s.last_amount > s.typical_amount * 1.05 && s.last_amount - s.typical_amount >= 2) {
      drafts.push({ type: 'price_increase', severity: 'warning', dedupeKey: `price:${s.merchant_key}:${s.account_id}:${s.last_date}`,
        title: `עליית מחיר: ${rows.at(-1)?.description ?? s.merchant_key}`,
        message: `מ-${ils(s.typical_amount)} ל-${ils(s.last_amount)} בחודש.` });
    }
  }

  // balance forecast and card charges vs balances
  const forecast = buildForecast(db, { asOf });
  for (const a of forecast.accounts) {
    if (a.lowest.amount < forecast.buffer) {
      drafts.push({ type: 'low_balance', severity: a.lowest.amount < 0 ? 'critical' : 'warning',
        dedupeKey: `lowbal:${a.accountId}:${forecast.cycle.key}:${a.lowest.amount < 0 ? 'neg' : 'buf'}`,
        title: `${a.displayName} צפוי לרדת ל-${a.lowest.amount < 0 ? '-' : ''}${ils(a.lowest.amount)}`,
        message: `הנקודה הנמוכה צפויה ב-${a.lowest.date}. כרית הביטחון: ${ils(forecast.buffer)}.` });
    }
  }
  const balances = new Map(forecast.accounts.map(a => [a.accountId, a.startBalance]));
  for (const c of upcomingCardCharges(db, txs, asOf).filter(c => daysBetween(asOf, c.chargeDate) <= 10)) {
    const balance = c.billingBankAccountId ? balances.get(c.billingBankAccountId) : undefined;
    if (balance != null && c.expectedAmount > balance) {
      drafts.push({ type: 'card_vs_balance', severity: 'warning', dedupeKey: `cardbal:${c.cardAccountId}:${c.chargeDate}`,
        title: `חיוב ${c.displayName} גבוה מהיתרה`,
        message: `${ils(c.expectedAmount)} יחויבו ב-${c.chargeDate}, ביתרה יש ${ils(balance)}.` });
    }
  }

  for (const t of txs.filter(t => t.date >= addDays(asOf, -30) && t.kind === 'expense'
    && (FEE_PATTERN.test(t.description) || t.categoryName === 'עמלות בנקאיות'))) {
    drafts.push({ type: 'fee', severity: 'info', dedupeKey: `fee:${t.id}`, title: `עמלה: ${t.description}`,
      message: `${ils(t.amount)} ב-${t.date}.`, txnIds: [t.id] });
  }

  for (const bill of unmatchedCardBills(txs, asOf)) {
    drafts.push({ type: 'unmatched_card_bill', severity: 'info', dedupeKey: `unmatchedbill:${bill.id}`,
      title: `חיוב כרטיס ללא פירוט: ${bill.description}`,
      message: `${ils(bill.amount)} ב-${bill.processedDate} — הכרטיס לא נסרק, ולכן ההוצאות שלו חסרות. אפשר לסמן את השורה כהוצאה.`,
      txnIds: [bill.id] });
  }

  // planned expenses that should have been charged by now but no matching row arrived
  for (const p of listPlanned(db).filter(i => isOverdue(i, asOf))) {
    drafts.push({ type: 'planned_overdue', severity: 'info', dedupeKey: `planned:${p.id}:${p.date}`,
      title: `עוד לא חויב: ${p.description}`,
      message: `${ils(p.amount)} היה צפוי ב-${p.date}. עדיין רלוונטי? אפשר לדחות או לבטל בעמוד ״קבועות החודש״.` });
  }

  // latest scrape per company failed
  const runs = db.prepare(`
    SELECT company, success, error_type, error_message, started_at FROM scrape_runs r
    WHERE id = (SELECT MAX(id) FROM scrape_runs WHERE company = r.company)
  `).all() as { company: string; success: number; error_type: string | null; error_message: string | null; started_at: string }[];
  for (const r of runs.filter(r => !r.success)) {
    drafts.push({ type: 'scrape_failed', severity: 'warning', dedupeKey: `scrape:${r.company}:${r.started_at.slice(0, 10)}`,
      title: `הסריקה של ${r.company} נכשלה`, message: `${r.error_type ?? ''} ${r.error_message ?? ''}`.trim() });
  }

  // large spend day: more than 3× the typical daily dynamic spend (helps spot fraud)
  const daily = new Map<string, number>();
  for (const t of txs.filter(t => t.date >= addDays(asOf, -120) && t.date <= asOf)) daily.set(t.date, (daily.get(t.date) ?? 0) + spendOf(t));
  const typicalDay = median([...daily.values()]);
  for (const [date, sum] of daily) {
    if (date >= recentSince && typicalDay > 0 && sum > typicalDay * 5 && sum > 2000) {
      drafts.push({ type: 'big_day', severity: 'info', dedupeKey: `bigday:${date}`, title: `יום הוצאות גבוה: ${date}`,
        message: `${ils(sum)} ביום אחד, לעומת ${ils(typicalDay)} ביום רגיל.` });
    }
  }
  return drafts;
}

/** Store new alerts (existing ones keep their seen/dismissed state). Returns the new count. */
export function refreshAlerts(db: DB, asOf = today()): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO alerts (type, severity, dedupe_key, title, message, txn_ids, data_json)
    VALUES (@type, @severity, @dedupeKey, @title, @message, @txnIds, @data)
  `);
  let added = 0;
  db.transaction(() => {
    for (const a of generateAlerts(db, asOf)) {
      added += insert.run({ ...a, txnIds: a.txnIds ? JSON.stringify(a.txnIds) : null, data: a.data ? JSON.stringify(a.data) : null }).changes;
    }
  })();
  return added;
}

export interface AlertNotice { id: number; type: string; severity: AlertDraft['severity']; title: string; message: string }

/** Alerts not yet shown as a desktop notification (and not dismissed), marked as shown. */
export function takeAlertsToNotify(db: DB): AlertNotice[] {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, type, severity, title, message FROM alerts
      WHERE notified_at IS NULL AND dismissed_at IS NULL ORDER BY id`).all() as AlertNotice[];
    db.prepare(`UPDATE alerts SET notified_at = CURRENT_TIMESTAMP WHERE notified_at IS NULL`).run();
    return rows;
  })();
}
