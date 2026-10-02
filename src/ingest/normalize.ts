import crypto from 'crypto';
import type { ScraperScrapingResult } from 'israeli-bank-scrapers';

export type ScrapedAccount = NonNullable<ScraperScrapingResult['accounts']>[number];
export type ScrapedTransaction = ScrapedAccount['txns'][number];

export interface NormalizedTransaction {
  identifier: string;
  legacyIdentifier: string;
  accountId: string;
  date: string;
  processedDate: string | null;
  description: string;
  memo: string | null;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency: string;
  status: string | null;
  txnType: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  bankIdentifier: string | null;
  sourceCategory: string | null;
  rawJson: string | null;
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** First 10 chars of the ISO string — kept identical to the original identifier scheme. */
export const dateKey = (iso: string) => iso.substring(0, 10);

/** Calendar date in Israel (scrapers return local midnight as e.g. 2026-01-06T22:00:00Z). */
export function localDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
}

/** The pre-migration identifier: md5(account|date|description|amount|currency). */
export function legacyIdentifier(accountId: string, date: string, description: string,
  originalAmount: number, originalCurrency: string): string {
  return md5(`${accountId}|${dateKey(date)}|${description}|${originalAmount}|${originalCurrency}`);
}

/**
 * Normalize one account's scraped transactions and assign stable identities.
 *
 * - With a bank reference (asmachta) the identity is built from it, plus the installment
 *   number because every installment of a purchase shares the same reference.
 * - Without one, the legacy hash is used. Identical rows on the same day (two coffees)
 *   get an occurrence suffix so both are kept — the old scheme silently merged them.
 */
export function normalizeTransactions(accountId: string, txns: ScrapedTransaction[]): NormalizedTransaction[] {
  const seen = new Map<string, number>();

  // Mizrahi's pending rows with income only come back with a NaN amount (upstream TODO); the row
  // arrives again, with its amount, once the bank posts it
  const usable = txns.filter(t => Number.isFinite(t.originalAmount));
  if (usable.length < txns.length) console.warn(`  skipped ${txns.length - usable.length} row(s) with no amount`);

  return usable.map(txn => {
    const originalCurrency = txn.originalCurrency || 'ILS';
    const chargedAmount = txn.chargedAmount ?? txn.originalAmount;
    const bankIdentifier = txn.identifier != null && String(txn.identifier).trim() !== ''
      ? String(txn.identifier).trim() : null;
    const legacy = legacyIdentifier(accountId, txn.date, txn.description, txn.originalAmount, originalCurrency);

    const baseKey = bankIdentifier
      ? md5(`ref|${accountId}|${bankIdentifier}|${dateKey(txn.date)}|${txn.originalAmount}|${txn.installments?.number ?? ''}`)
      : legacy;
    const occurrence = seen.get(baseKey) ?? 0;
    seen.set(baseKey, occurrence + 1);

    return {
      identifier: occurrence === 0 ? baseKey : md5(`${baseKey}|#${occurrence}`),
      legacyIdentifier: legacy,
      accountId,
      date: txn.date,
      processedDate: txn.processedDate || null,
      description: txn.description,
      memo: txn.memo || null,
      originalAmount: txn.originalAmount,
      originalCurrency,
      chargedAmount,
      chargedCurrency: txn.chargedCurrency || 'ILS',
      status: txn.status || null,
      txnType: txn.type || null,
      installmentNumber: txn.installments?.number ?? null,
      installmentTotal: txn.installments?.total ?? null,
      bankIdentifier,
      sourceCategory: txn.category || null,
      rawJson: txn.rawTransaction ? JSON.stringify(txn.rawTransaction) : null,
    };
  });
}
