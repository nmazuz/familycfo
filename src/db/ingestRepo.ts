import type { DB } from './connection.js';
import { BANK_COMPANIES, friendlyAccountName } from './migrations.js';
import { dateKey, normalizeTransactions, type NormalizedTransaction, type ScrapedAccount } from '../ingest/normalize.js';

export interface SaveResult {
  insertedIds: number[];
  updated: number;
  updatedIds: number[];
}

/**
 * Store one scraped account: upsert the account, record its balance and insert/update
 * its transactions. User-owned fields (category, member, business, tags, notes...) are
 * never overwritten here — only data that comes from the bank.
 */
export function saveScrapedAccount(db: DB, companyId: string, account: ScrapedAccount): SaveResult & { accountId: string } {
  const accountId = `${companyId}:${account.accountNumber}`;

  db.prepare(`
    INSERT INTO accounts (id, company, kind, display_name, card_frame, currency, is_savings, last_scraped_at)
    VALUES (@id, @company, @kind, @displayName, @cardFrame, @currency, @isSavings, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      card_frame = COALESCE(excluded.card_frame, accounts.card_frame),
      currency = excluded.currency,
      is_savings = MAX(accounts.is_savings, excluded.is_savings),
      last_scraped_at = CURRENT_TIMESTAMP,
      active = 1
  `).run({
    id: accountId,
    company: companyId,
    kind: BANK_COMPANIES.has(companyId) ? 'bank' : 'card',
    displayName: friendlyAccountName(accountId),
    cardFrame: account.cardFrame ?? null,
    currency: account.currency ?? 'ILS',
    isSavings: account.savingsAccount ? 1 : 0,
  });

  const balance = account.balance
    ?? (account as { info?: { futureChargesTotal?: number } }).info?.futureChargesTotal ?? 0;
  db.prepare(`INSERT INTO balances (account_id, balance) VALUES (?, ?)`).run(accountId, balance);

  const result = saveTransactions(db, normalizeTransactions(accountId, account.txns ?? []));
  return { accountId, ...result };
}

export function saveTransactions(db: DB, txns: NormalizedTransaction[]): SaveResult {
  const byIdentifier = db.prepare(`SELECT id FROM transactions WHERE identifier = ?`).pluck();
  const existingStatus = db.prepare('SELECT status FROM transactions WHERE id = ?').pluck();
  const legacyMatch = db.prepare(
    `SELECT id FROM transactions WHERE identifier = ? AND bank_identifier IS NULL`
  ).pluck();
  // A pending row that has since completed (completed rows get a reference and a charged amount)
  const pendingRows = db.prepare(`
    SELECT id, identifier, bank_identifier, date, description, original_amount, original_currency, installment_number
    FROM transactions WHERE account_id = ?
      AND (status = 'pending' OR (status IS NULL AND charged_amount = 0))
    ORDER BY id
  `);

  // Same transaction, different reference: some banks (Hapoalim) renumber the reference between scrapes.
  // Candidates are matched one-to-one, so two identical coffees on the same day stay two rows.
  const sameRow = db.prepare(`
    SELECT id, identifier FROM transactions
    WHERE account_id = ? AND substr(date, 1, 10) = ? AND description = ? AND charged_amount = ?
      AND COALESCE(installment_number, 0) = ?
    ORDER BY id
  `);

  const updateBankFields = db.prepare(`
    UPDATE transactions SET
      identifier = @identifier, date = @date, processed_date = @processedDate, memo = @memo,
      description = @description, original_amount = @originalAmount, original_currency = @originalCurrency,
      charged_amount = @chargedAmount, charged_currency = @chargedCurrency, status = @status,
      txn_type = @txnType, installment_number = @installmentNumber,
      installment_total = @installmentTotal, bank_identifier = @bankIdentifier,
      source_category = COALESCE(@sourceCategory, source_category),
      raw_json = COALESCE(@rawJson, raw_json), updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  const insert = db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, memo,
      original_amount, original_currency, charged_amount, charged_currency, status, txn_type,
      installment_number, installment_total, bank_identifier, source_category, raw_json)
    VALUES (@identifier, @accountId, @date, @processedDate, @description, @memo,
      @originalAmount, @originalCurrency, @chargedAmount, @chargedCurrency, @status, @txnType,
      @installmentNumber, @installmentTotal, @bankIdentifier, @sourceCategory, @rawJson)
  `);

  const insertedIds: number[] = [];
  let updated = 0;
  const updatedIds: number[] = [];

  const incoming = new Set(txns.map(t => t.identifier));
  const claimed = new Set<number>();
  const pendingMatch = (t: NormalizedTransaction): number | undefined => {
    if (t.status === 'pending') return undefined;
    const candidates = (pendingRows.all(t.accountId) as {
      id: number; identifier: string; bank_identifier: string | null; date: string; description: string;
      original_amount: number; original_currency: string; installment_number: number | null;
    }[]).filter(r => !claimed.has(r.id) && !incoming.has(r.identifier)
      && r.installment_number === t.installmentNumber);
    // A stable reference can identify a pending row even when its amount, date or description changes.
    const refs = candidates.filter(r => t.bankIdentifier && r.bank_identifier === t.bankIdentifier
      && Math.abs(Date.parse(t.date) - Date.parse(r.date)) <= 7 * 86400_000);
    if (refs.length === 1) return refs[0].id;
    const similar = candidates.filter(r => dateKey(r.date) === dateKey(t.date) && r.description === t.description
      && r.original_currency === t.originalCurrency);
    const exact = similar.filter(r => r.original_amount === t.originalAmount);
    if (exact.length) return exact[0].id;
    // A zero placeholder carries no amount to disambiguate two purchases: leave uncertain matches separate.
    const zeros = similar.filter(r => r.original_amount === 0);
    const incomingSimilar = txns.filter(o => o.status !== 'pending' && o.accountId === t.accountId
      && dateKey(o.date) === dateKey(t.date) && o.description === t.description
      && o.originalCurrency === t.originalCurrency && o.installmentNumber === t.installmentNumber);
    return zeros.length === 1 && incomingSimilar.length === 1 ? zeros[0].id : undefined;
  };
  const fuzzyMatch = (t: NormalizedTransaction): number | undefined => {
    const rows = sameRow.all(t.accountId, dateKey(t.date), t.description, t.chargedAmount, t.installmentNumber ?? 0) as { id: number; identifier: string }[];
    // skip rows another incoming transaction will match by its own identifier
    return rows.find(r => !claimed.has(r.id) && !incoming.has(r.identifier))?.id;
  };

  db.transaction(() => {
    for (const t of txns) {
      const existingId =
        (byIdentifier.get(t.identifier) as number | undefined) ??
        // rows saved before the migration carry the legacy identifier and no bank reference
        (t.bankIdentifier ? legacyMatch.get(t.legacyIdentifier) as number | undefined : undefined) ??
        pendingMatch(t) ??
        fuzzyMatch(t);
      if (existingId != null) claimed.add(existingId);

      if (existingId != null) {
        // Overlapping bank windows can still contain an old pending copy after settlement.
        if (t.status === 'pending' && existingStatus.get(existingId) === 'completed') continue;
        updateBankFields.run({ ...t, id: existingId });
        updated++;
        updatedIds.push(existingId);
      } else {
        const id = Number(insert.run(t).lastInsertRowid);
        claimed.add(id);
        insertedIds.push(id);
      }
    }
  })();

  return { insertedIds, updated, updatedIds };
}

export function recordScrapeRun(db: DB, run: {
  company: string; startedAt: string; success: boolean;
  errorType?: string; errorMessage?: string; newTransactions?: number;
}): void {
  db.prepare(`
    INSERT INTO scrape_runs (company, started_at, finished_at, success, error_type, error_message, new_transactions)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
  `).run(run.company, run.startedAt, run.success ? 1 : 0, run.errorType ?? null,
    run.errorMessage ?? null, run.newTransactions ?? 0);
}
