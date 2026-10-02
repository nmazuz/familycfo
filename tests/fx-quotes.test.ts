import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { normalizeCurrency, rateToIls, refreshBoiRates, setRate, toIls } from '../src/analytics/fx.js';
import { fetchHistory, fetchQuote, majorUnits, refreshHistory, refreshQuotes, saveQuote, searchSymbols, startOf } from '../src/analytics/quotes.js';
import { testDb } from './helpers.js';

let db: DB;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { db = testDb(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00:00Z')); });
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const chart = (meta: object, rest = {}) => ({ chart: { result: [{ meta, ...rest }] } });
const holding = (symbol: string, currency = 'ILS', manual: number | null = null) => db.prepare('INSERT INTO holdings (symbol, quantity, currency, manual_price, buy_date) VALUES (?, 2, ?, ?, ?)').run(symbol, currency, manual, '2026-08-01');

describe('currency rates', () => {
  it.each([[null, 'ILS'], ['', 'ILS'], ['₪', 'ILS'], ['nis', 'ILS'], [' usd ', 'USD'], ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP']])('normalizes %s', (input, expected) => expect(normalizeCurrency(input)).toBe(expected));
  it('uses the latest prior rate, then earliest known, never a later rate when a prior exists', () => {
    setRate(db, '2026-08-01', '$', 3); setRate(db, '2026-09-01', 'USD', 4);
    expect(rateToIls(db, 'USD', '2026-08-15')).toBe(3);
    expect(rateToIls(db, 'USD', '2026-07-01')).toBe(3);
    expect(toIls(db, -10, 'USD', '2026-10-01')).toBe(-40);
    expect(rateToIls(db, 'ILS', '2026-01-01')).toBe(1);
    expect(rateToIls(db, 'XYZ', '2026-01-01')).toBeNull();
    expect(toIls(db, 10, 'XYZ', '2026-01-01')).toBe(10);
  });
  it('upserts a rate and its provenance', () => {
    setRate(db, '2026-08-01', 'USD', 3, 'boi'); setRate(db, '2026-08-01', '$', 4);
    expect(db.prepare('SELECT currency, rate_to_ils, source FROM fx_rates').get()).toEqual({ currency: 'USD', rate_to_ils: 4, source: 'manual' });
  });
  it('divides BOI quoted units and persists dates and source', async () => {
    fetchMock.mockResolvedValue(response({ exchangeRates: [{ key: 'JPY', currentExchangeRate: 2.5, unit: 100, lastUpdate: '2026-09-15T10:00:00Z' }] }));
    expect(await refreshBoiRates(db)).toBe(1);
    expect(rateToIls(db, 'JPY', '2026-09-15')).toBe(0.025);
    expect(fetchMock).toHaveBeenCalledWith('https://boi.org.il/PublicApi/GetExchangeRates', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('rejects failed BOI responses without altering saved rates', async () => {
    setRate(db, '2026-08-01', 'USD', 3);
    fetchMock.mockResolvedValue(response({}, 503));
    await expect(refreshBoiRates(db)).rejects.toThrow('HTTP 503');
    expect(rateToIls(db, 'USD', '2026-09-15')).toBe(3);
  });
  it('handles an empty BOI payload', async () => { fetchMock.mockResolvedValue(response({})); expect(await refreshBoiRates(db)).toBe(0); });
});

describe('market data contracts and caching', () => {
  it.each([['ILA', 'ILS', 0.01], ['GBp', 'GBP', 0.01], ['GBX', 'GBP', 0.01], ['ZAc', 'ZAR', 0.01], ['USD', 'USD', 1], [null, 'ILS', 1]])('major units for %s', (input, currency, factor) => expect(majorUnits(input)).toEqual({ currency, factor }));
  it('encodes symbols and converts price and previous close from minor units', async () => {
    fetchMock.mockResolvedValue(response(chart({ symbol: 'TEST.TA', currency: 'ILA', regularMarketPrice: 12345, chartPreviousClose: 12000, shortName: 'Invented fund', regularMarketTime: 1789473600 })));
    expect(await fetchQuote(' test.ta ')).toMatchObject({ symbol: 'TEST.TA', currency: 'ILS', price: 123.45, previousClose: 120, name: 'Invented fund' });
    expect(fetchMock.mock.calls[0][0]).toContain('/TEST.TA?');
  });
  it.each([
    [chart({ currency: 'USD' }), 'no price'],
    [{ chart: { error: { description: 'symbol not found' } } }, 'symbol not found'],
  ])('rejects invalid quote payload', async (body, error) => { fetchMock.mockResolvedValue(response(body)); await expect(fetchQuote('TEST')).rejects.toThrow(error); });
  it('defaults optional quote metadata and uses previousClose fallback', async () => {
    fetchMock.mockResolvedValue(response(chart({ regularMarketPrice: 10, previousClose: 9 })));
    expect(await fetchQuote(' test ')).toEqual({ symbol: 'TEST', name: null, currency: 'ILS', price: 10, previousClose: 9, exchange: null, instrumentType: null, marketTime: null });
  });
  it('filters missing closes and dates history in the exchange offset', async () => {
    fetchMock.mockResolvedValue(response(chart({ currency: 'ILA', gmtoffset: 10800 }, { timestamp: [Date.parse('2026-08-01T22:00:00Z') / 1000, Date.parse('2026-08-02T22:00:00Z') / 1000], indicators: { quote: [{ close: [12000, null] }] } })));
    expect(await fetchHistory('TEST', '2026-08-01')).toEqual([{ date: '2026-08-02', close: 120 }]);
  });
  it('search filters unsupported instruments and supplies metadata fallbacks', async () => {
    fetchMock.mockResolvedValue(response({ quotes: [{ symbol: 'TEST', quoteType: 'ETF', shortname: 'Test' }, { symbol: 'FX', quoteType: 'CURRENCY' }, { quoteType: 'ETF' }] }));
    expect(await searchSymbols(' test fund ')).toEqual([{ symbol: 'TEST', name: 'Test', exchange: null, type: 'ETF' }]);
    expect(fetchMock.mock.calls[0][0]).toContain('q=test%20fund');
  });
  it('search failures return no matches', async () => { fetchMock.mockResolvedValue(response({}, 503)); expect(await searchSymbols('TEST')).toEqual([]); });
  it('saveQuote clears stale errors, updates quoted holdings but not manual currencies', () => {
    holding('TEST', 'USD'); holding('TEST', 'EUR', 10);
    db.prepare("INSERT INTO quotes (symbol, error) VALUES ('TEST', 'old failure')").run();
    saveQuote(db, { symbol: 'TEST', name: null, currency: 'ILS', price: 10, previousClose: null, exchange: null, instrumentType: null, marketTime: null });
    expect(db.prepare('SELECT error, price FROM quotes').get()).toEqual({ error: null, price: 10 });
    expect(db.prepare('SELECT currency FROM holdings ORDER BY id').pluck().all()).toEqual(['ILS', 'EUR']);
  });
  it('deduplicates concurrent refreshes and skips fresh or manual holdings', async () => {
    holding('TEST'); holding('MANUAL', 'ILS', 10);
    fetchMock.mockResolvedValue(response(chart({ symbol: 'TEST', currency: 'ILS', regularMarketPrice: 20 })));
    const a = refreshQuotes(db); const b = refreshQuotes(db);
    expect(a).toBe(b); expect(await a).toEqual({ updated: 1, failed: 0 });
    expect(await refreshQuotes(db)).toEqual({ updated: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps the last price and records errors when refresh fails', async () => {
    holding('TEST'); db.prepare("INSERT INTO quotes (symbol, price, fetched_at) VALUES ('TEST', 42, '2020-01-01')").run();
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await refreshQuotes(db)).toEqual({ updated: 0, failed: 1 });
    expect(db.prepare('SELECT price, error FROM quotes').get()).toEqual({ price: 42, error: 'offline' });
  });
  it('Yahoo FX never overwrites BOI rates', async () => {
    holding('TEST', 'USD'); setRate(db, '2026-09-15', 'USD', 3.5, 'boi');
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(chart(url.includes('USDILS') ? { regularMarketPrice: 9, currency: 'ILS' } : { symbol: 'TEST', regularMarketPrice: 20, currency: 'USD' }))));
    await refreshQuotes(db);
    expect(rateToIls(db, 'USD', '2026-09-15')).toBe(3.5);
  });
  it('history refresh persists closes and preserves official FX', async () => {
    holding('HISTORYTEST', 'USD'); setRate(db, '2026-08-01', 'USD', 3.5, 'boi');
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(chart({ currency: 'USD' }, { timestamp: [Date.parse('2026-08-01T12:00:00Z') / 1000], indicators: { quote: [{ close: [url.includes('USDILS') ? 9 : 50] }] } }))));
    expect(await refreshHistory(db, true)).toBe(2);
    expect(db.prepare("SELECT close FROM quote_history WHERE symbol='HISTORYTEST'").pluck().get()).toBe(50);
    expect(rateToIls(db, 'USD', '2026-08-01')).toBe(3.5);
    expect(await refreshHistory(db)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ buy_date: '2026-01-01', baseline_date: '2026-02-01' }, '2026-01-01'],
    [{ baseline_date: '2026-02-01' }, '2026-02-01'], [{ created_at: '2026-03-01 12:00:00' }, '2026-03-01'], [{}, '2026-09-15'],
  ])('selects the holding start date', (h, expected) => expect(startOf(h)).toBe(expected));
});
