import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChartCandlestick, ChartPie, Coins, LineChart, Pencil, RefreshCw, Search, Sparkles, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { api, type Holding, type LiveQuote, type Portfolio, type SymbolMatch } from '../api';
import { day, fullDate, moneyIn } from '../format';
import { Empty, ErrorBox, Field, Loading, MemberBadge, MemberSelect, Modal, Money, PageHeader, SectionTitle, Stat } from '../components/ui';
import { DonutChart, SimpleLine } from '../components/charts';
import { askAgent } from '../components/AgentChat';
import { cn } from '@/lib/utils';

const priceIn = (n: number | null | undefined, currency: string) => {
  if (n == null) return '—';
  try { return new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 4 }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; }
};
const signedPct = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
const toneOf = (n: number | null | undefined) => (n == null || n === 0 ? '' : n > 0 ? 'text-positive' : 'text-negative');

type Draft = Partial<Holding> & { manual?: boolean };

export default function Investments() {
  const qc = useQueryClient();
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['investments'], queryFn: () => api.get<Portfolio>('/investments'), refetchInterval: 60_000,
  });
  const [editing, setEditing] = useState<Draft | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.post<Portfolio>('/investments/refresh', {}),
    onSuccess: d => { qc.setQueryData(['investments'], d); qc.invalidateQueries({ queryKey: ['networth'] }); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const { holdings, totals, history } = data;
  const sorted = [...holdings].sort((a, b) => b.valueIls - a.valueIls);

  return (
    <>
      <PageHeader icon={ChartCandlestick} title="השקעות בשוק ההון"
        subtitle={<>מחירים חיים מ-Yahoo Finance (מתעדכנים כל דקה) · עודכן {time(totals.quotesAsOf)} · נכלל בשווי הנקי ב"חסכונות והון"</>}
        actions={<>
          <button type="button" className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className={cn((refresh.isPending || isFetching) && 'animate-spin')} />רענון מחירים
          </button>
          {holdings.length > 0 && <button type="button" className="btn" onClick={() => askAgent('תן לי סקירה של תיק ההשקעות שלי בשוק ההון', true)}><Sparkles />סקירה עם העוזר</button>}
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ החזקה</button>
        </>} />

      {holdings.length === 0 ? (
        <Empty>עוד אין החזקות. הוסיפו נייר (למשל AAPL, VOO, TEVA.TA) וכמות — השווי יחושב לפי המחיר העדכני. מחיר קנייה רשות: בלעדיו התשואה נמדדת מהיום.</Empty>
      ) : <>
        <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
          <Stat index={0} icon={Wallet} label="שווי התיק" value={totals.valueIls} spark={history.length > 1 ? history.map(h => h.value) : undefined}
            hint={`${totals.count} החזקות`} />
          <Stat index={1} icon={TrendingUp} tone={totals.gainIls >= 0 ? 'good' : 'bad'} label="רווח / הפסד" value={totals.gainIls}
            delta={totals.gainPct != null ? { value: totals.gainPct / 100, label: 'מהעלות' } : undefined} />
          <Stat index={2} icon={LineChart} color="var(--chart-5)" label="שינוי היום" value={totals.dayChangeIls}
            hint={totals.dayChangePct != null ? <span className={toneOf(totals.dayChangePct)}>{signedPct(totals.dayChangePct)}</span> : 'השווקים עוד לא נסחרו היום'} />
          <Stat index={3} icon={Coins} color="var(--chart-2)" label="עלות / בסיס" value={totals.costIls} hint="מחיר הקנייה, או המחיר ביום שהנייר נוסף" />
        </div>

        {totals.errors > 0 && (
          <div className="card mt-4 flex items-center gap-2 border-warning/40 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            {totals.errors} ניירות לא התעדכנו ברענון האחרון — מוצג המחיר הקודם שלהם.
          </div>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="card min-w-0">
            <SectionTitle icon={LineChart}>שווי התיק לאורך זמן</SectionTitle>
            {history.length > 1
              ? <SimpleLine data={history} dataKey="value" formatX={day} height={240} />
              : <div className="text-sm text-zinc-500">הגרף מתחיל מתאריך הקנייה של כל נייר. בלי תאריך קנייה — הוא יתמלא מהיום והלאה; אפשר להוסיף תאריך בעריכת הנייר.</div>}
          </div>
          <div className="card min-w-0">
            <SectionTitle icon={ChartPie} color="var(--chart-5)">פיזור</SectionTitle>
            <DonutChart height={200} centerLabel="שווי" data={holdings.map(h => ({ key: String(h.id), name: h.name, value: h.valueIls }))} />
          </div>
        </div>

        <div className="card mt-4 p-0">
          <SectionTitle icon={ChartCandlestick} color="var(--chart-2)">החזקות</SectionTitle>
          <div className="scroll-x"><table className="table">
            <thead><tr>
              <th>נייר</th><th className="text-end">כמות</th><th className="text-end">שער נוכחי</th>
              <th className="text-end">שווי</th><th className="text-end">רווח / הפסד</th><th className="text-end">עלות</th><th className="text-end">נתח</th><th>איפה</th><th />
            </tr></thead>
            <tbody>
              {sorted.map(h => (
                <tr key={h.id}>
                  <td className="min-w-48">
                    <div className="font-medium">{h.name}</div>
                    <div className="text-xs text-zinc-500" dir="ltr" style={{ textAlign: 'right' }}>
                      {h.priceSource === 'manual' ? 'מחיר ידני' : h.symbol}{h.exchange && h.priceSource !== 'manual' ? ` · ${h.exchange}` : ''}
                    </div>
                    {h.quoteError && <div className="text-xs text-warning">לא התעדכן: {h.quoteError}</div>}
                  </td>
                  <td className="num text-end">{h.quantity.toLocaleString('he-IL')}</td>
                  <td className="num whitespace-nowrap text-end">
                    <div>{priceIn(h.price, h.currency)}</div>
                    {h.priceSource === 'quote' && h.priceAsOf && <div className="text-[11px] text-muted-foreground">נכון ל־{day(h.priceAsOf)} {time(h.priceAsOf)}</div>}
                    {h.priceSource === 'manual'
                      ? h.manualPriceDate && <div className="text-xs text-zinc-500">{day(h.manualPriceDate)}</div>
                      : <div className={cn('text-xs', toneOf(h.dayChangePct) || 'text-zinc-500')}>{h.dayChangePct == null ? 'לא נסחר היום' : signedPct(h.dayChangePct)}</div>}
                  </td>
                  <td className="whitespace-nowrap text-end">
                    <Money value={h.valueIls} />
                    {h.currency !== 'ILS' && <div className="num text-xs text-zinc-500">{moneyIn(h.value, h.currency)}</div>}
                  </td>
                  <td className={cn('whitespace-nowrap text-end', toneOf(h.gainIls))}>
                    {h.gainIls != null ? <Money value={h.gainIls} /> : '—'}
                    <div className="num text-xs">{signedPct(h.gainIlsPct)}
                      {h.currency !== 'ILS' && h.gainPct != null && Math.abs(h.gainPct - (h.gainIlsPct ?? 0)) >= 0.05 && <span className="text-zinc-500"> · ב-{h.currency} {signedPct(h.gainPct)}</span>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-end text-sm">
                    {h.costIls != null ? <Money value={h.costIls} /> : '—'}
                    <div className="text-xs text-zinc-500">
                      {h.basis === 'buy' ? `קנייה ${priceIn(h.buyPrice, h.currency)}` : h.basis === 'baseline' ? `בסיס מ-${day(h.baselineDate)}` : ''}
                    </div>
                  </td>
                  <td className="num text-end text-sm">{totals.valueIls ? `${Math.round((h.valueIls / totals.valueIls) * 100)}%` : '—'}</td>
                  <td className="whitespace-nowrap text-sm">
                    <div className="flex items-center gap-1.5">{h.broker ?? ''}<MemberBadge id={h.ownerMemberId} /></div>
                  </td>
                  <td><button className="btn-ghost btn-icon" aria-label="עריכה" onClick={() => setEditing({ ...h, manual: h.priceSource === 'manual' })}><Pencil /></button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          רווח בשקלים כולל את השפעת שער המטבע (עלות לפי השער ביום הקנייה, כשהוא ידוע). המחירים עשויים להתעכב עד 15 דקות בבורסה.
          לשרת המחירים נשלחים רק סימולי הניירות — לא כמויות ולא שווי.
        </p>
      </>}

      {editing && <HoldingEditor draft={editing} onClose={() => setEditing(null)} onSaved={() => {
        setEditing(null);
        for (const k of ['investments', 'networth']) qc.invalidateQueries({ queryKey: [k] });
      }} />}
    </>
  );
}

function HoldingEditor({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !d.id;
  const set = (patch: Draft) => setD(prev => ({ ...prev, ...patch }));

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(t); }, [query]);
  const results = useQuery({
    queryKey: ['symbol-search', debounced], enabled: isNew && !d.manual && debounced.length > 0,
    queryFn: () => api.get<SymbolMatch[]>(`/investments/search?q=${encodeURIComponent(debounced)}`),
  });
  const quote = useQuery({
    queryKey: ['quote', d.symbol], enabled: isNew && !d.manual && !!d.symbol, retry: false,
    queryFn: () => api.get<LiveQuote>(`/investments/quote?symbol=${encodeURIComponent(d.symbol!)}`),
  });
  const currency = d.manual ? d.currency ?? 'ILS' : quote.data?.currency ?? d.currency ?? '';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        symbol: d.manual ? (d.symbol || d.name || 'MANUAL') : d.symbol, name: d.name || null, quantity: Number(d.quantity),
        buyPrice: d.buyPrice ?? null, buyDate: d.buyDate || null, broker: d.broker || null, ownerMemberId: d.ownerMemberId ?? null,
        notes: d.notes || null,
        ...(d.manual ? { manualPrice: d.manualPrice ?? null, currency: d.currency ?? 'ILS' } : {}),
      };
      return isNew ? api.post('/investments/holdings', body) : api.patch(`/investments/holdings/${d.id}`, body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  });
  const remove = useMutation({ mutationFn: () => api.del(`/investments/holdings/${d.id}`), onSuccess: onSaved });
  const valid = Number(d.quantity) > 0 && (d.manual ? d.manualPrice != null && !!(d.name || d.symbol) : !!d.symbol && (!isNew || !!quote.data));

  return (
    <Modal title={isNew ? 'החזקה חדשה' : `עריכה — ${d.name}`} onClose={onClose} footer={<>
      {!isNew && (confirmDelete
        ? <><span className="me-auto text-sm">למחוק את {d.name}?</span><button className="btn" onClick={() => setConfirmDelete(false)}>לא</button>
          <button className="btn btn-primary" onClick={() => remove.mutate()}>כן, מחק</button></>
        : <button className="btn me-auto" onClick={() => setConfirmDelete(true)}><Trash2 />מחיקה</button>)}
      {!confirmDelete && <>
        <button className="btn" onClick={onClose}>ביטול</button>
        <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>שמור</button>
      </>}
    </>}>
      {isNew && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!d.manual} onChange={e => set({ manual: e.target.checked, symbol: e.target.checked ? '' : d.symbol })} />
          אין לו מחיר בשוק (קרן נאמנות, מזומן בתיק) — אעדכן מחיר ידנית
        </label>
      )}

      {!d.manual && isNew && (
        <Field label="נייר (שם או סימול באנגלית — AAPL, VOO, TEVA.TA)">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input className="input ps-8" dir="ltr" value={query} placeholder="nvidia / LUMI.TA"
              onChange={e => { setQuery(e.target.value); set({ symbol: undefined }); }}
              onKeyDown={e => { if (e.key === 'Enter' && query.trim()) set({ symbol: query.trim().toUpperCase() }); }} />
          </div>
          {!d.symbol && (results.data?.length ?? 0) > 0 && (
            <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-line">
              {results.data!.map(r => (
                <button key={r.symbol} type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm hover:bg-surface-muted"
                  onClick={() => { set({ symbol: r.symbol, name: d.name }); setQuery(r.symbol); }}>
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="shrink-0 text-xs text-zinc-500" dir="ltr">{r.symbol} · {r.exchange}</span>
                </button>
              ))}
            </div>
          )}
          {/[֐-׿]/.test(query) && <div className="mt-1 text-xs text-zinc-500">החיפוש עובד באנגלית בלבד. מניות בתל אביב: הסימול עם ‎.TA (למשל LUMI.TA)</div>}
          {d.symbol && (
            <div className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-sm">
              {quote.isLoading ? 'בודק מחיר…' : quote.error ? <span className="text-negative">{(quote.error as Error).message}</span> : quote.data && <>
                <span className="font-medium">{quote.data.name ?? quote.data.symbol}</span> · <span dir="ltr">{quote.data.symbol}</span> ·{' '}
                <span className="num font-semibold">{priceIn(quote.data.price, quote.data.currency)}</span>
                {quote.data.exchange && <span className="text-zinc-500"> · {quote.data.exchange}</span>}
              </>}
            </div>
          )}
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="שם לתצוגה"><input className="input" value={d.name ?? ''} placeholder={quote.data?.name ?? ''} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="כמות (יחידות)"><input className="input num" type="number" min={0} step="any" value={d.quantity ?? ''} onChange={e => set({ quantity: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
        {d.manual && <>
          <Field label="מחיר ליחידה"><input className="input num" type="number" step="any" value={d.manualPrice ?? ''} onChange={e => set({ manualPrice: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          <Field label="מטבע"><select className="input" value={d.currency ?? 'ILS'} onChange={e => set({ currency: e.target.value })}>
            {['ILS', 'USD', 'EUR', 'GBP'].map(c => <option key={c}>{c}</option>)}
          </select></Field>
        </>}
        <Field label={`מחיר קנייה ממוצע ליחידה${currency ? ` (${currency})` : ''} — רשות`}>
          <input className="input num" type="number" step="any" value={d.buyPrice ?? ''} onChange={e => set({ buyPrice: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Field label="תאריך קנייה — רשות"><input className="input" type="date" value={d.buyDate ?? ''} onChange={e => set({ buyDate: e.target.value || null })} /></Field>
        <Field label="איפה (בית השקעות / ברוקר)"><input className="input" value={d.broker ?? ''} onChange={e => set({ broker: e.target.value })} placeholder="IBKR, מיטב טרייד…" /></Field>
        <Field label="של מי"><MemberSelect value={d.ownerMemberId ?? null} emptyLabel="משותף" onChange={id => set({ ownerMemberId: id })} /></Field>
      </div>
      <div className="text-xs text-zinc-500">
        {d.buyPrice != null
          ? 'התשואה תחושב ממחיר הקנייה.'
          : !isNew && d.baselineDate ? `בלי מחיר קנייה — התשואה נמדדת מהמחיר ב-${fullDate(d.baselineDate)} (${priceIn(d.baselinePrice, currency || 'ILS')}).`
          : 'בלי מחיר קנייה — המחיר של היום יישמר כבסיס, והתשואה תימדד ממנו והלאה.'}
        {currency === 'ILS' && !d.manual && ' מניות בת״א — מחיר בשקלים (לא באגורות).'}
        {' '}תאריך הקנייה ממלא את גרף השווי לאחור.
      </div>
      <Field label="הערות"><textarea className="input" rows={2} value={d.notes ?? ''} onChange={e => set({ notes: e.target.value })} /></Field>
      {err && <div className="text-sm text-negative">{err}</div>}
    </Modal>
  );
}
