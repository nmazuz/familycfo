import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, qs } from '../web/src/api.js';
import { day, fullDate, money, moneyIn, monthName, pct, todayIso } from '../web/src/format.js';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('web API transport', () => {
  it.each(['get', 'del'] as const)('%s does not add a body or JSON content type', async method => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', mock); expect(await api[method]('/test')).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith('/api/test', { method: method === 'get' ? 'GET' : 'DELETE', headers: undefined, body: undefined });
  });
  it.each(['post', 'patch', 'put'] as const)('%s serializes a JSON body', async method => {
    const mock = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', mock);
    await api[method]('/test', { name: 'Invented Hebrew עברית', amount: 0 });
    expect(mock).toHaveBeenCalledWith('/api/test', { method: method.toUpperCase(), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Invented Hebrew עברית', amount: 0 }) });
  });
  it('surfaces JSON errors and non-JSON status text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400 })).mockResolvedValueOnce(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })));
    await expect(api.get('/test')).rejects.toThrow('Invalid data'); await expect(api.get('/test')).rejects.toThrow('Bad Gateway');
  });
  it('query string preserves zero, encodes special characters, joins arrays and omits empty values', () => {
    expect(qs({ zero: 0, term: 'a&b עברית', tags: [1, 2], missing: null, undef: undefined, empty: '', list: [] })).toBe('?zero=0&term=a%26b+%D7%A2%D7%91%D7%A8%D7%99%D7%AA&tags=1%2C2');
    expect(qs({ a: null })).toBe('');
  });
});
describe('Hebrew display helpers', () => {
  it('distinguishes absent values from zero and supports cents', () => {
    expect(money(null)).toBe('—'); expect(money(undefined)).toBe('—');
    expect(money(0)).toContain('0'); expect(money(1.25, true)).toContain('1.25');
    expect(pct(null)).toBe('—'); expect(pct(0)).toBe('0%'); expect(pct(12.6)).toBe('13%');
  });
  it('formats foreign and invalid currencies without throwing', () => {
    expect(moneyIn(1234, 'USD')).toContain('1,234'); expect(moneyIn(1234, 'INVALID')).toBe('1,234 INVALID');
  });
  it('formats dates and handles absent dates', () => {
    expect(day(null)).toBe('—'); expect(fullDate(undefined)).toBe('—');
    expect(day('2026-09-01')).toContain('1'); expect(fullDate('2026-09-01')).toContain('2026'); expect(monthName('2026-09')).toContain('2026');
  });
  it('today uses Israel date even while UTC is on the previous day', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T22:30:00Z')); expect(todayIso()).toBe('2026-09-02');
  });
});
