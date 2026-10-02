import type { DB } from '../db/connection.js';
import { round, today } from './common.js';
import { toIls } from './fx.js';
import { bankBalances } from './forecast.js';
import { holdingValues, portfolioHistory } from './investments.js';

export interface NetWorthItem {
  id: string;
  name: string;
  group: 'bank' | 'asset' | 'card_debt' | 'liability';
  type: string;
  ownerMemberId: number | null;
  provider: string | null;
  currency: string;
  value: number;
  valueIls: number;
  asOf: string | null;
  liquidityDate: string | null;
}

export interface NetWorth {
  asOf: string;
  items: NetWorthItem[];
  totals: { assets: number; liabilities: number; netWorth: number; liquid: number };
  byType: Record<string, number>;
  byOwner: Record<string, number>;
  history: { date: string; netWorth: number }[];
}

/** Net worth (#7, #17): bank + manual assets + stock holdings − open card charges − loans, all in ILS. */
export function netWorth(db: DB, asOf = today()): NetWorth {
  const items: NetWorthItem[] = [];

  for (const b of bankBalances(db, true)) {
    const currency = b.currency || 'ILS';
    items.push({ id: `bank:${b.id}`, name: b.display_name ?? b.id, group: b.is_savings ? 'asset' : 'bank',
      type: b.is_savings ? 'bank_savings' : 'bank', ownerMemberId: b.owner_member_id, provider: b.id.split(':')[0],
      currency, value: b.balance, valueIls: round(toIls(db, b.balance, currency, asOf)), asOf: b.balanceDate, liquidityDate: null });
  }

  const assets = db.prepare(`
    SELECT a.*, s.value, s.currency AS snap_currency, s.date AS snap_date FROM assets a
    LEFT JOIN asset_snapshots s ON s.id = (SELECT id FROM asset_snapshots WHERE asset_id = a.id ORDER BY date DESC, id DESC LIMIT 1)
    WHERE a.archived = 0
  `).all() as Record<string, any>[];
  for (const a of assets) {
    const currency = a.snap_currency ?? a.currency;
    const value = a.value ?? 0;
    items.push({ id: `asset:${a.id}`, name: a.name, group: 'asset', type: a.type, ownerMemberId: a.owner_member_id,
      provider: a.provider, currency, value, valueIls: round(toIls(db, value, currency, a.snap_date ?? asOf)),
      asOf: a.snap_date, liquidityDate: a.liquidity_date });
  }

  // stock-market holdings at their latest quote: one item per broker + owner
  const portfolios = new Map<string, NetWorthItem>();
  for (const h of holdingValues(db, asOf)) {
    const key = `${h.broker ?? ''}|${h.ownerMemberId ?? ''}`;
    const item = portfolios.get(key) ?? { id: `portfolio:${key}`, name: h.broker ? `תיק מניות — ${h.broker}` : 'תיק מניות', group: 'asset' as const,
      type: 'brokerage', ownerMemberId: h.ownerMemberId, provider: h.broker, currency: 'ILS', value: 0, valueIls: 0,
      asOf: null, liquidityDate: null };
    item.value = round(item.value + h.valueIls);
    item.valueIls = item.value;
    const at = h.priceAsOf?.slice(0, 10) ?? null;
    if (at && (!item.asOf || at > item.asOf)) item.asOf = at;
    portfolios.set(key, item);
  }
  items.push(...portfolios.values());

  // purchases already made on cards but not yet charged
  const cardDebt = db.prepare(`
    SELECT a.id, a.display_name, a.owner_member_id, SUM(t.charged_amount) AS pending
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'card' AND t.processed_date > ? AND t.excluded = 0
    GROUP BY a.id
  `).all(`${asOf}T23:59:59`) as { id: string; display_name: string | null; owner_member_id: number | null; pending: number }[];
  for (const c of cardDebt) {
    items.push({ id: `card:${c.id}`, name: c.display_name ?? c.id, group: 'card_debt', type: 'card', ownerMemberId: c.owner_member_id,
      provider: c.id.split(':')[0], currency: 'ILS', value: c.pending, valueIls: round(c.pending), asOf, liquidityDate: null });
  }

  const liabilities = db.prepare(`
    SELECT l.*, s.balance, s.date AS snap_date FROM liabilities l
    LEFT JOIN liability_snapshots s ON s.id = (SELECT id FROM liability_snapshots WHERE liability_id = l.id ORDER BY date DESC, id DESC LIMIT 1)
    WHERE l.archived = 0
  `).all() as Record<string, any>[];
  for (const l of liabilities) {
    const balance = -(l.balance ?? l.original_principal ?? 0);
    items.push({ id: `liability:${l.id}`, name: l.name, group: 'liability', type: l.type, ownerMemberId: l.owner_member_id,
      provider: l.lender, currency: 'ILS', value: balance, valueIls: balance, asOf: l.snap_date, liquidityDate: l.end_date });
  }

  const assetsTotal = items.filter(i => i.valueIls > 0).reduce((s, i) => s + i.valueIls, 0);
  const liabilitiesTotal = items.filter(i => i.valueIls < 0).reduce((s, i) => s + i.valueIls, 0);
  // pension and real estate are never liquid; a provident fund (gemel) only from the date it's set to
  const liquid = items.filter(i => i.group === 'bank' || (i.group === 'asset' && (!i.liquidityDate || i.liquidityDate <= asOf)
    && !['pension', 'real_estate'].includes(i.type) && !(i.type === 'kupat_gemel' && !i.liquidityDate)))
    .reduce((s, i) => s + i.valueIls, 0);
  const sumBy = (key: (i: NetWorthItem) => string) => items.reduce<Record<string, number>>((acc, i) => {
    acc[key(i)] = round((acc[key(i)] ?? 0) + i.valueIls);
    return acc;
  }, {});

  return {
    asOf,
    items,
    totals: { assets: round(assetsTotal), liabilities: round(liabilitiesTotal), netWorth: round(assetsTotal + liabilitiesTotal), liquid: round(liquid) },
    byType: sumBy(i => i.type),
    byOwner: sumBy(i => String(i.ownerMemberId ?? 'shared')),
    history: netWorthHistory(db),
  };
}

/** Month-end net worth from asset/liability snapshots, the bank balance history and the holdings' daily closes. */
function netWorthHistory(db: DB): { date: string; netWorth: number }[] {
  const months = db.prepare(`
    SELECT DISTINCT substr(date, 1, 7) AS m FROM asset_snapshots
    UNION SELECT DISTINCT substr(date, 1, 7) FROM liability_snapshots
    UNION SELECT DISTINCT substr(timestamp, 1, 7) FROM balances
    ORDER BY m
  `).pluck().all() as string[];
  const stocks = portfolioHistory(db);
  const stocksOn = (d: string) => stocks.filter(p => p.date <= d).at(-1)?.value ?? 0;
  return months.map(m => {
    const end = `${m}-31`;
    const bank = db.prepare(`
      SELECT COALESCE(SUM(balance), 0) FROM balances b
      WHERE b.id IN (SELECT MAX(id) FROM balances WHERE substr(timestamp, 1, 10) <= ?
        AND account_id IN (SELECT id FROM accounts WHERE kind = 'bank' AND COALESCE(currency, 'ILS') = 'ILS') GROUP BY account_id)
    `).pluck().get(end) as number;
    const assets = (db.prepare(`
      SELECT s.value, s.currency, s.date FROM asset_snapshots s
      WHERE s.id = (SELECT id FROM asset_snapshots WHERE asset_id = s.asset_id AND date <= ? ORDER BY date DESC, id DESC LIMIT 1)
    `).all(end) as { value: number; currency: string; date: string }[])
      .reduce((sum, s) => sum + toIls(db, s.value, s.currency, s.date), 0);
    const debts = db.prepare(`
      SELECT COALESCE(SUM(balance), 0) FROM liability_snapshots s
      WHERE s.id = (SELECT id FROM liability_snapshots WHERE liability_id = s.liability_id AND date <= ? ORDER BY date DESC, id DESC LIMIT 1)
    `).pluck().get(end) as number;
    return { date: m, netWorth: round(bank + assets + stocksOn(end) - debts) };
  });
}
