import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { cycleByKey, cycleStartDay, filterTx, incomeOf, loadTransactions, merchantKey, NON_SPEND_KINDS, refundOf, spendOf, type Tx } from '../../analytics/common.js';
import { applyRules, deriveKinds } from '../../ingest/classify.js';
import { localDate } from '../../ingest/normalize.js';
import { pickColumns, toApi } from '../crud.js';
import { MANUAL_ACCOUNT_ID } from '../../db/migrations.js';
import { isOverdue, linkPlanned, listPlanned, matchPlanned, plannedCandidates, plannedPayments, unlinkPlanned, type PlannedItem } from '../../analytics/planned.js';

interface TxQuery {
  from?: string; to?: string; cycle?: string; member?: string; business?: string; tags?: string;
  category?: string; account?: string; search?: string; kind?: string; review?: string; hideCardPayments?: string;
  /** YYYY-MM-DD: only card rows charged in that statement (same card, same charge month) */
  charge?: string;
  limit?: string; offset?: string; followUp?: string; showZero?: string; scrapeBatch?: string;
}

const EDITABLE = ['category_id', 'member_id', 'business_id', 'business_share_pct', 'kind', 'fixed_override', 'excluded', 'notes', 'follow_up'];

export function parseFilter(q: TxQuery) {
  return {
    memberId: q.member ? Number(q.member) : undefined,
    businessId: q.business ? Number(q.business) : undefined,
    tagIds: q.tags ? q.tags.split(',').map(Number).filter(Boolean) : undefined,
    categoryId: q.category ? Number(q.category) : undefined,
    accountId: q.account || undefined,
    search: q.search || undefined,
  };
}

/** Rows that need a human look: no category, or a suggested payback link waiting. */
function needsReview(t: Tx): boolean {
  return t.categoryId == null && t.kind === 'expense';
}

export function transactionRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/transactions', async req => {
    const q = req.query as TxQuery;
    let from = q.from, to = q.to;
    if (q.cycle && !q.charge) ({ start: from, end: to } = cycleByKey(q.cycle, cycleStartDay(db)));
    let txs = filterTx(loadTransactions(db, { from, to, includeExcluded: true }), parseFilter(q));
    // a card is charged once a month, so a statement = its rows whose charge date falls in that month
    if (q.charge) txs = txs.filter(t => t.processedDate.slice(0, 7) === q.charge!.slice(0, 7));
    if (q.kind) txs = txs.filter(t => q.kind!.split(',').includes(t.kind));
    if (q.showZero !== '1') txs = txs.filter(t => t.amount !== 0);
    if (q.followUp === '1') txs = txs.filter(t => t.followUp);
    if (q.scrapeBatch) {
      const batch = q.scrapeBatch === 'latest' ? db.prepare('SELECT MAX(id) FROM scrape_batches').pluck().get() : Number(q.scrapeBatch);
      txs = txs.filter(t => t.scrapeBatchId === batch);
    }
    if (q.review === '1') txs = txs.filter(needsReview);
    txs.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.id - a.id);
    const offset = Number(q.offset ?? 0), limit = Math.min(Number(q.limit ?? 200), 2000);
    const accounts = new Map((db.prepare(`SELECT id, display_name FROM accounts`).all() as { id: string; display_name: string | null }[])
      .map(a => [a.id, a.display_name ?? a.id]));
    const excluded = new Set(db.prepare(`SELECT id FROM transactions WHERE excluded = 1`).pluck().all() as number[]);
    if (q.hideCardPayments === '1') txs = txs.filter(t => t.kind !== 'card_payment');
    // describe the other side of immediate-debit pairs ("ויזה" bank row ↔ the card purchase)
    const brief = new Map((db.prepare(`SELECT t.id, t.description, t.date, a.display_name FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.id IN (SELECT matched_txn_id FROM transactions WHERE matched_txn_id IS NOT NULL)
         OR t.matched_txn_id IS NOT NULL`).all() as { id: number; description: string; date: string; display_name: string | null }[])
      .map(r => [r.id, r]));
    const linkOf = (t: Tx) => {
      const other = t.matchedTxnId ?? t.settledByTxnId;
      const o = other != null ? brief.get(other) : undefined;
      return o ? { id: other, description: o.description, account: o.display_name, date: localDate(o.date) } : null;
    };
    // the same income / spend as everywhere else: household share, net of refunds and paybacks —
    // transfers between own accounts, savings and card bills move money but aren't income or spend
    const counted = txs.filter(t => !excluded.has(t.id));
    const sum = (f: (t: Tx) => number, list = counted) => list.reduce((s, t) => s + f(t), 0);
    const business = q.business != null && q.business !== '';
    return {
      total: txs.length,
      totals: {
        // a business view shows the business's own share
        income: business ? sum(t => (t.kind === 'income' ? Math.max(0, t.businessAmount) : 0)) : sum(incomeOf),
        spend: business ? sum(t => (t.kind === 'expense' ? Math.max(0, -t.businessAmount) : 0)) : sum(t => spendOf(t) - refundOf(t)),
        businessIncome: business ? 0 : sum(t => (t.kind === 'income' && !t.linkedInflow ? Math.max(0, t.businessAmount) : 0)),
        businessSpend: business ? 0 : sum(t => (t.kind === 'expense' ? Math.max(0, -t.businessAmount) : 0)),
        /** transfers, savings and card bills (in + out) — shown so the gap to the bank statement is clear */
        moved: sum(t => (NON_SPEND_KINDS.has(t.kind) ? Math.abs(t.amount) : 0)),
      },
      rows: txs.slice(offset, offset + limit).map(t => ({ ...t, accountName: accounts.get(t.accountId), excluded: excluded.has(t.id), link: linkOf(t) })),
    };
  });

  const update = (id: number, body: Record<string, unknown>) => {
    const values = pickColumns(body, EDITABLE);
    if ('follow_up' in values) {
      if (values.follow_up !== 0 && values.follow_up !== 1 && typeof values.follow_up !== 'boolean') throw Object.assign(new Error('followUp must be boolean or 0/1'), { statusCode: 400 });
      values.follow_up = values.follow_up ? 1 : 0;
    }
    const sets = Object.keys(values).map(k => `${k} = @${k}`);
    if ('category_id' in values) sets.push(`category_source = 'manual'`);
    if ('kind' in values) sets.push(values.kind == null ? `kind_source = 'auto'` : `kind_source = 'manual'`);
    if (sets.length) {
      db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @__id`).run({ ...values, __id: id });
    }
    if (Array.isArray(body.tagIds)) {
      db.prepare(`DELETE FROM transaction_tags WHERE transaction_id = ?`).run(id);
      const add = db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`);
      for (const tagId of body.tagIds as number[]) add.run(id, tagId);
    }
    if (Array.isArray(body.removeTagIds)) {
      const del = db.prepare(`DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?`);
      for (const tagId of body.removeTagIds as number[]) del.run(id, tagId);
    }
    if (Array.isArray(body.addTagIds)) {
      const add = db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`);
      for (const tagId of body.addTagIds as number[]) add.run(id, tagId);
    }
    if ('kind' in values && values.kind == null) deriveKinds(db, [id]);
  };

  // ---- manual entries (cash, paid by someone else… — not on any scraped account) -----------
  interface ManualBody { date: string; description: string; amount: number; kind?: 'expense' | 'income'; notes?: string | null }
  const manualValues = (b: ManualBody) => {
    const description = String(b.description ?? '').trim();
    const amount = Math.abs(Number(b.amount));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '') || !description || !(amount > 0)) return null;
    // stored like scraped rows (ISO); noon in Israel so the local date never shifts
    const iso = new Date(`${b.date}T12:00:00+03:00`).toISOString();
    const signed = b.kind === 'income' ? amount : -amount;
    return { iso, description, signed, kind: b.kind === 'income' ? 'income' : 'expense' };
  };
  const isManual = (id: number) => db.prepare(`SELECT account_id FROM transactions WHERE id = ?`).pluck().get(id) === MANUAL_ACCOUNT_ID;

  app.post('/api/transactions/manual', async (req, reply) => {
    const b = req.body as ManualBody & Record<string, unknown>;
    const v = manualValues(b);
    if (!v) return reply.code(400).send({ error: 'צריך תאריך, תיאור וסכום' });
    const id = db.transaction(() => {
      const newId = Number(db.prepare(`
        INSERT INTO transactions (identifier, account_id, date, processed_date, description, original_amount, original_currency,
          charged_amount, charged_currency, status, txn_type, kind, kind_source)
        VALUES (?, ?, ?, ?, ?, ?, 'ILS', ?, 'ILS', 'completed', 'normal', ?, 'manual')
      `).run(`manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, MANUAL_ACCOUNT_ID, v.iso, v.iso, v.description,
        v.signed, v.signed, v.kind).lastInsertRowid);
      // category, member, business, tags, notes — the same fields as editing a scraped row
      update(newId, b);
      return newId;
    })();
    return loadTransactions(db, { includeExcluded: true }).find(t => t.id === id) ?? null;
  });

  app.put('/api/transactions/:id/manual', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!isManual(id)) return reply.code(400).send({ error: 'רק תנועות שהוזנו ידנית ניתנות לעריכה כך' });
    const b = req.body as ManualBody & Record<string, unknown>;
    const v = manualValues(b);
    if (!v) return reply.code(400).send({ error: 'צריך תאריך, תיאור וסכום' });
    db.transaction(() => {
      db.prepare(`UPDATE transactions SET date = ?, processed_date = ?, description = ?, original_amount = ?, charged_amount = ?,
        kind = ?, kind_source = 'manual', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(v.iso, v.iso, v.description, v.signed, v.signed, v.kind, id);
      update(id, b);
    })();
    return loadTransactions(db, { includeExcluded: true }).find(t => t.id === id) ?? null;
  });

  // only hand-entered rows can be deleted — scraped rows come back on the next scrape (hide them instead)
  app.delete('/api/transactions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!isManual(id)) return reply.code(400).send({ error: 'אפשר למחוק רק תנועות שהוזנו ידנית' });
    db.transaction(() => {
      db.prepare(`DELETE FROM transaction_tags WHERE transaction_id = ?`).run(id);
      db.prepare(`DELETE FROM transaction_links WHERE from_txn_id = ? OR to_txn_id = ?`).run(id, id);
      db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
    })();
    return { ok: true };
  });

  // ---- planned expenses (known in advance, not charged yet) -----------------------------------
  const plannedValues = (b: Record<string, any>) => {
    const description = String(b.description ?? '').trim();
    const amount = Math.abs(Number(b.amount));
    const installments = Math.max(1, Math.min(60, Math.round(Number(b.installments ?? 1)) || 1));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '') || !description || !(amount > 0) || !b.accountId) return null;
    return { description, amount, date: b.date, account_id: b.accountId, installments, match_pattern: String(b.matchPattern ?? '').trim() || null,
      category_id: b.categoryId ?? null, member_id: b.memberId ?? null, tag_ids: JSON.stringify(b.tagIds ?? []), notes: String(b.notes ?? '').trim() || null };
  };
  const afterPlannedChange = () => matchPlanned(db);

  app.get('/api/planned', async req => {
    const statuses = String((req.query as { status?: string }).status ?? 'planned').split(',') as PlannedItem['status'][];
    const txs = loadTransactions(db);
    const claimed = new Set(db.prepare(`SELECT matched_txn_id FROM planned_items WHERE matched_txn_id IS NOT NULL`).pluck().all() as number[]);
    return listPlanned(db, statuses).map(i => ({
      ...i, overdue: isOverdue(i), payments: plannedPayments(i, txs),
      candidates: i.status === 'planned' ? plannedCandidates(i, txs, claimed).map(t => ({ id: t.id, description: t.description, date: t.date, amount: t.amount })) : [],
    }));
  });

  app.post('/api/planned', async (req, reply) => {
    const v = plannedValues(req.body as Record<string, unknown>);
    if (!v) return reply.code(400).send({ error: 'צריך תאריך, תיאור, סכום ואיך משלמים' });
    const id = Number(db.prepare(`INSERT INTO planned_items (description, amount, date, account_id, installments, match_pattern, category_id, member_id, tag_ids, notes)
      VALUES (@description, @amount, @date, @account_id, @installments, @match_pattern, @category_id, @member_id, @tag_ids, @notes)`).run(v).lastInsertRowid);
    // it may already be on the statement
    const matched = afterPlannedChange().matched;
    return { id, matched: matched > 0 };
  });

  app.put('/api/planned/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = plannedValues(req.body as Record<string, unknown>);
    if (!v) return reply.code(400).send({ error: 'צריך תאריך, תיאור, סכום ואיך משלמים' });
    db.prepare(`UPDATE planned_items SET description = @description, amount = @amount, date = @date, account_id = @account_id, installments = @installments,
      match_pattern = @match_pattern, category_id = @category_id, member_id = @member_id, tag_ids = @tag_ids, notes = @notes, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id`).run({ ...v, id });
    afterPlannedChange();
    return { ok: true };
  });

  /** status changes: cancel, back to planned (undo a match), postpone by N months */
  app.patch('/api/planned/:id', async req => {
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { status?: PlannedItem['status']; postponeMonths?: number };
    if (b.status === 'cancelled') db.prepare(`UPDATE planned_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    if (b.status === 'planned') unlinkPlanned(db, id);
    if (b.postponeMonths) {
      const date = db.prepare(`SELECT date FROM planned_items WHERE id = ?`).pluck().get(id) as string;
      const d = new Date(`${date}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + b.postponeMonths);
      db.prepare(`UPDATE planned_items SET date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.toISOString().slice(0, 10), id);
    }
    if (b.status !== 'cancelled') afterPlannedChange();
    return { ok: true };
  });

  /** the user picked which row it was (when several could be) */
  app.post('/api/planned/:id/match', async req => {
    linkPlanned(db, Number((req.params as { id: string }).id), Number((req.body as { txId: number }).txId));
    return { ok: true };
  });

  app.delete('/api/planned/:id', async req => {
    db.prepare(`DELETE FROM planned_items WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  app.patch('/api/transactions/:id', async req => {
    const id = Number((req.params as { id: string }).id);
    db.transaction(() => update(id, req.body as Record<string, unknown>))();
    return loadTransactions(db, { includeExcluded: true }).find(t => t.id === id) ?? null;
  });

  app.post('/api/transactions/bulk', async req => {
    const { ids, patch } = req.body as { ids: number[]; patch: Record<string, unknown> };
    db.transaction(() => { for (const id of ids) update(id, patch); })();
    return { updated: ids.length };
  });

  /** Rows with the same merchant — offered as "apply to all similar" after a manual edit. */
  app.get('/api/transactions/:id/similar', async req => {
    const id = Number((req.params as { id: string }).id);
    const all = loadTransactions(db, { includeExcluded: true });
    const tx = all.find(t => t.id === id);
    if (!tx) return { merchant: null, count: 0, ids: [] };
    const similar = all.filter(t => t.id !== id && t.merchant === tx.merchant);
    return { merchant: tx.merchant, pattern: tx.description, count: similar.length, ids: similar.map(t => t.id) };
  });

  // ---- rules ------------------------------------------------------------------------------
  app.get('/api/rules', async () => (db.prepare(`SELECT * FROM category_rules ORDER BY priority DESC, id DESC`).all() as Record<string, unknown>[]).map(toApi));

  app.post('/api/rules', async req => {
    const body = req.body as Record<string, unknown> & { tagIds?: number[]; applyToExisting?: boolean; fromTransactionId?: number };
    let pattern = body.pattern as string | undefined;
    // from a transaction: match its merchant key (drops per-transaction codes)
    if (!pattern && body.fromTransactionId) {
      const desc = db.prepare(`SELECT description FROM transactions WHERE id = ?`).pluck().get(body.fromTransactionId) as string;
      pattern = merchantKey(desc);
    }
    const values = {
      match_type: body.matchType ?? 'contains',
      pattern,
      account_id: body.accountId ?? null,
      min_amount: body.minAmount ?? null,
      max_amount: body.maxAmount ?? null,
      set_category_id: body.setCategoryId ?? null,
      set_business_id: body.setBusinessId ?? null,
      set_business_share_pct: body.setBusinessSharePct ?? null,
      set_member_id: body.setMemberId ?? null,
      set_kind: body.setKind ?? null,
      set_tag_ids: body.tagIds?.length ? JSON.stringify(body.tagIds) : null,
      priority: body.priority ?? 10,
    };
    const id = Number(db.prepare(`
      INSERT INTO category_rules (match_type, pattern, account_id, min_amount, max_amount, set_category_id,
        set_business_id, set_business_share_pct, set_member_id, set_kind, set_tag_ids, priority)
      VALUES (@match_type, @pattern, @account_id, @min_amount, @max_amount, @set_category_id,
        @set_business_id, @set_business_share_pct, @set_member_id, @set_kind, @set_tag_ids, @priority)
    `).run(values).lastInsertRowid);
    const applied = body.applyToExisting === false ? [] : applyRules(db, 'all');
    if (applied.length) deriveKinds(db, applied);
    return { id, applied: applied.length };
  });

  app.delete('/api/rules/:id', async req => {
    db.prepare(`DELETE FROM category_rules WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  // ---- payback / refund links -------------------------------------------------------------
  app.get('/api/links', async req => {
    const status = (req.query as { status?: string }).status ?? 'suggested';
    const rows = db.prepare(`
      SELECT l.*, f.description AS from_description, f.date AS from_date, f.charged_amount AS from_amount,
        t.description AS to_description, t.date AS to_date, t.charged_amount AS to_amount
      FROM transaction_links l JOIN transactions f ON f.id = l.from_txn_id JOIN transactions t ON t.id = l.to_txn_id
      WHERE l.status = ? ORDER BY f.date DESC
    `).all(status) as Record<string, unknown>[];
    return rows.map(toApi);
  });

  app.post('/api/links', async req => {
    const b = req.body as { fromTxnId: number; toTxnId: number; type?: string; amount?: number };
    const amount = b.amount ?? (db.prepare(`SELECT charged_amount FROM transactions WHERE id = ?`).pluck().get(b.fromTxnId) as number);
    db.prepare(`INSERT INTO transaction_links (from_txn_id, to_txn_id, type, amount, status) VALUES (?, ?, ?, ?, 'confirmed')
      ON CONFLICT(from_txn_id, to_txn_id) DO UPDATE SET status = 'confirmed'`).run(b.fromTxnId, b.toTxnId, b.type ?? 'payback', Math.abs(amount));
    return { ok: true };
  });

  app.patch('/api/links/:id', async req => {
    const { status } = req.body as { status: 'confirmed' | 'rejected' };
    db.prepare(`UPDATE transaction_links SET status = ? WHERE id = ?`).run(status, Number((req.params as { id: string }).id));
    return { ok: true };
  });
}
