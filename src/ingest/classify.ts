import type { DB } from '../db/connection.js';
import { categorize } from '../categorizer.js';
import { merchantKey } from '../analytics/common.js';

// JS `\b` only knows ASCII word characters, so Hebrew words need an explicit end-of-word lookahead
const WORD_END = `(?=$|[\\s\\-–'"״׳])`;

/** Bank-account rows that pay a credit-card bill (the purchases are already stored per card). */
export const CARD_PAYMENT_PATTERN = new RegExp(
  `^(ויזה|כאל|ישראכרט|מקס|לאומי קארד|לאומיקארד|לאומי מאסטרקרד|מאסטרקרד|אמריקן אקספרס|דיינרס|max|visa|isracard|cal)${WORD_END}`, 'i');

/** Standing orders into savings plans / deposits. */
export const SAVINGS_PATTERN = /לחיסכון|לחסכון|פיקדון|פקדון|קופת גמל|השקעה ב/;

export interface Rule {
  id: number;
  match_type: 'exact' | 'contains';
  pattern: string;
  account_id: string | null;
  min_amount: number | null;
  max_amount: number | null;
  set_category_id: number | null;
  set_business_id: number | null;
  set_business_share_pct: number | null;
  set_member_id: number | null;
  set_kind: string | null;
  set_tag_ids: string | null;
  priority: number;
}

interface TxRow {
  id: number;
  account_id: string;
  description: string;
  charged_amount: number;
  source_category: string | null;
  category_id: number | null;
  category_source: string | null;
  kind_source: string | null;
}

export function ruleMatches(rule: Rule, tx: Pick<TxRow, 'description' | 'account_id' | 'charged_amount'>): boolean {
  const desc = tx.description.trim().toLowerCase();
  const pattern = rule.pattern.trim().toLowerCase();
  // patterns saved from "apply to similar" are merchant keys (no punctuation or codes), so compare both forms
  const key = merchantKey(desc);
  if (rule.match_type === 'exact' ? desc !== pattern && key !== pattern : !desc.includes(pattern) && !key.includes(pattern)) return false;
  if (rule.account_id && rule.account_id !== tx.account_id) return false;
  const amount = Math.abs(tx.charged_amount);
  if (rule.min_amount != null && amount < rule.min_amount) return false;
  if (rule.max_amount != null && amount > rule.max_amount) return false;
  return true;
}

export function loadRules(db: DB): Rule[] {
  return db.prepare(`SELECT * FROM category_rules ORDER BY priority DESC, id DESC`).all() as Rule[];
}

/**
 * Apply rules to transactions. Fields the user edited by hand (category_source / kind_source
 * = 'manual') are left alone. Returns the ids that changed.
 */
export function applyRules(db: DB, txIds: number[] | 'all', rules = loadRules(db)): number[] {
  if (!rules.length) return [];
  const rows = (txIds === 'all'
    ? db.prepare(`SELECT * FROM transactions`).all()
    : txIds.map(id => db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id)).filter(Boolean)
  ) as (TxRow & { business_id: number | null; member_id: number | null })[];

  const setCategory = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?`);
  const setKind = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'rule' WHERE id = ?`);
  const setBusiness = db.prepare(`UPDATE transactions SET business_id = ?, business_share_pct = ? WHERE id = ?`);
  const setMember = db.prepare(`UPDATE transactions SET member_id = ? WHERE id = ?`);
  const addTag = db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`);
  const changed: number[] = [];

  db.transaction(() => {
    for (const tx of rows) {
      const rule = rules.find(r => ruleMatches(r, tx));
      if (!rule) continue;
      if (rule.set_category_id && tx.category_source !== 'manual') setCategory.run(rule.set_category_id, tx.id);
      if (rule.set_kind && tx.kind_source !== 'manual') setKind.run(rule.set_kind, tx.id);
      if (rule.set_business_id && tx.business_id == null) {
        setBusiness.run(rule.set_business_id, rule.set_business_share_pct ?? 100, tx.id);
      }
      if (rule.set_member_id && tx.member_id == null) setMember.run(rule.set_member_id, tx.id);
      for (const tagId of JSON.parse(rule.set_tag_ids || '[]') as number[]) addTag.run(tx.id, tagId);
      changed.push(tx.id);
    }
  })();
  return changed;
}

/** A category by name, following aliases left by renames and merges. */
export function findCategory(db: DB, name: string): number | undefined {
  return (db.prepare(`SELECT id FROM categories WHERE name = ?`).pluck().get(name)
    ?? db.prepare(`SELECT category_id FROM category_aliases WHERE name = ?`).pluck().get(name)) as number | undefined;
}

export function getOrCreateCategory(db: DB, name: string): number {
  const existing = findCategory(db, name);
  if (existing) return existing;
  const kind = name.startsWith('הכנסה') ? 'income' : 'expense';
  return Number(db.prepare(`INSERT INTO categories (name, kind) VALUES (?, ?)`).run(name, kind).lastInsertRowid);
}

/**
 * Fill in categories for uncategorized rows: rules → same-description cache → the scraper's
 * own category (when it matches a known category) → the external categorization API.
 */
export async function categorizeTransactions(db: DB, txIds: number[], apiUrl?: string): Promise<void> {
  applyRules(db, txIds);

  const cache = db.prepare(`
    SELECT category_id FROM transactions
    WHERE description = ? AND category_id IS NOT NULL AND id != ?
    ORDER BY CASE category_source WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END, id DESC
    LIMIT 1
  `).pluck();
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?`);
  const apiCache = new Map<string, number | null>();

  for (const id of txIds) {
    const tx = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TxRow | undefined;
    if (!tx || tx.category_id != null || tx.category_source === 'manual') continue;

    const cached = cache.get(tx.description, tx.id) as number | undefined;
    if (cached) { set.run(cached, 'cache', tx.id); continue; }

    const fromScraper = tx.source_category ? findCategory(db, tx.source_category) : undefined;
    if (fromScraper) { set.run(fromScraper, 'scraper', tx.id); continue; }

    if (!apiUrl) continue;
    if (!apiCache.has(tx.description)) {
      const name = await categorize(tx.description, apiUrl);
      // only categories that exist (or old names aliased to one) — an unknown answer stays uncategorized
      const id = name ? findCategory(db, name) ?? null : null;
      if (name && !id) console.warn(`Categorizer answered an unknown category "${name}" for "${tx.description}"`);
      apiCache.set(tx.description, id);
    }
    const categoryId = apiCache.get(tx.description);
    if (categoryId) set.run(categoryId, 'api', tx.id);
  }
}

/**
 * Derive each row's kind (expense / income / refund / transfer / card_payment / savings)
 * unless a rule or the user set it. Card-bill rows on bank accounts become card_payment so
 * card purchases aren't counted twice.
 */
export function deriveKinds(db: DB, txIds: number[] | 'all'): void {
  const where = txIds === 'all' ? '' : `AND t.id IN (${txIds.map(Number).join(',') || 'NULL'})`;
  const rows = db.prepare(`
    SELECT t.id, t.description, t.charged_amount, a.kind AS account_kind, c.kind AS category_kind
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE COALESCE(t.kind_source, 'auto') = 'auto' ${where}
  `).all() as { id: number; description: string; charged_amount: number; account_kind: string; category_kind: string | null }[];

  const update = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'auto' WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) update.run(kindFor(r), r.id);
  })();
}

export function kindFor(r: { description: string; charged_amount: number; account_kind: string; category_kind: string | null }): string {
  if (r.account_kind === 'bank' && r.charged_amount < 0 && CARD_PAYMENT_PATTERN.test(r.description.trim())) {
    return 'card_payment';
  }
  if (r.category_kind === 'card_payment' && r.account_kind === 'bank') return 'card_payment';
  if (r.account_kind === 'bank' && r.charged_amount < 0 && SAVINGS_PATTERN.test(r.description)) return 'savings';
  if (r.category_kind === 'transfer' || r.category_kind === 'savings') return r.category_kind;
  if (r.charged_amount > 0) {
    return r.category_kind === 'income' || r.account_kind === 'bank' ? 'income' : 'refund';
  }
  return 'expense';
}
