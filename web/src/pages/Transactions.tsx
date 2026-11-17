import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CalendarDays, ChevronDown, ChevronUp, CreditCard, EyeOff, Flag, Hash, Inbox,
  MoreHorizontal, PenLine, PieChart, PiggyBank, Plus, Receipt, Scale, ShoppingBag, TrendingUp, Undo2, X,
} from 'lucide-react';
import { api, qs, type Tx } from '../api';
import { useFilters, useLookups } from '../state';
import { day, KIND_LABELS, monthName, todayIso } from '../format';
import {
  AccountSelect, AnimatedNumber, BusinessSelect, CategorySelect, Empty, ErrorBox, Field, Loading, MemberSelect, Modal, Money,
  NewTagInput, PageHeader, Picker, Stat, TagPicker, type PickerOption,
} from '../components/ui';
import { CategoryReport } from '../components/CategoryReport';
import { ManualEntry } from '../components/ManualEntry';
import { MemberAvatar } from '@/lib/visuals';

interface TxPage { total: number; totals: { income: number; spend: number; businessIncome: number; businessSpend: number; moved: number }; rows: Tx[] }
type SortKey = 'date' | 'description' | 'amount' | 'category' | 'member' | 'business' | 'account';

const KIND_ICONS: Record<string, ReactNode> = {
  expense: <ShoppingBag />, income: <TrendingUp />, refund: <Undo2 />, transfer: <ArrowLeftRight />,
  card_payment: <CreditCard />, savings: <PiggyBank />,
};
const kindOptions = (): PickerOption[] => Object.entries(KIND_LABELS).map(([k, v]) => ({ value: k, label: v, icon: KIND_ICONS[k] }));
const formatCount = (n: number) => Math.round(n).toLocaleString('he-IL');

function cycleOptions(n = 12): string[] {
  const d = new Date(`${todayIso().slice(0, 7)}-01T12:00:00`);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d);
    x.setMonth(d.getMonth() - i + 1);
    return x.toISOString().slice(0, 7);
  });
}

export default function Transactions() {
  const { params } = useFilters();
  const { member, business, tag, meta } = useLookups();
  const qc = useQueryClient();
  // filters can arrive in the URL (e.g. clicking a category on the dashboard)
  const [urlParams, setUrlParams] = useSearchParams();
  const [cycle, setCycle] = useState(urlParams.get('cycle') ?? todayIso().slice(0, 7));
  const [search, setSearch] = useState(urlParams.get('search') ?? '');
  const [category, setCategory] = useState<number | null>(urlParams.get('category') ? Number(urlParams.get('category')) : null);
  const [account, setAccount] = useState<string | null>(urlParams.get('account'));
  const [kind, setKind] = useState(urlParams.get('kind') ?? '');
  const [followUp, setFollowUp] = useState(urlParams.get('followUp') === '1');
  const [showZero, setShowZero] = useState(urlParams.get('showZero') === '1');
  const [scrapeBatch, setScrapeBatch] = useState<string | null>(urlParams.get('scrapeBatch'));
  const [review, setReview] = useState(urlParams.get('review') === '1');
  // a card statement (from clicking an upcoming card charge): that card's rows charged in that month
  const [charge, setCharge] = useState<string | null>(urlParams.get('charge'));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [hideCardPayments, setHideCardPayments] = useState(urlParams.get('hideCardPayments') !== '0');
  // keep the URL in sync so the filtered view can be bookmarked or opened again with Back
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('cycle', cycle);
    if (followUp) next.set('followUp', '1');
    if (showZero) next.set('showZero', '1');
    if (scrapeBatch) next.set('scrapeBatch', scrapeBatch);
    if (!hideCardPayments) next.set('hideCardPayments', '0');
    if (search) next.set('search', search);
    if (category != null) next.set('category', String(category));
    if (account) next.set('account', account);
    if (kind) next.set('kind', kind);
    if (review) next.set('review', '1');
    if (charge) next.set('charge', charge);
    setUrlParams(next, { replace: true });
  }, [cycle, search, category, account, kind, review, charge, followUp, showZero, scrapeBatch, hideCardPayments, setUrlParams]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Tx | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  // hand-entered rows (cash, paid by someone else…): null = closed, 'new' = adding, a row = editing it
  const [manual, setManual] = useState<Tx | 'new' | null>(null);
  const [suggestRule, setSuggestRule] = useState<{ tx: Tx; patch: Record<string, unknown>; count: number } | null>(null);

  const query = {
    ...params, search, category, account, kind, cycle: review ? undefined : cycle || undefined,
    followUp: followUp ? 1 : undefined, showZero: showZero ? 1 : undefined, scrapeBatch: scrapeBatch ?? undefined,
    review: review ? 1 : undefined, charge: charge ?? undefined, hideCardPayments: hideCardPayments ? 1 : undefined, limit: 1000,
  };
  const { data, isLoading, error } = useQuery({ queryKey: ['transactions', query], queryFn: () => api.get<TxPage>(`/transactions${qs(query)}`) });

  const invalidate = () => {
    for (const k of ['transactions', 'summary', 'budgets', 'cashflow', 'planning', 'forecast', 'month-plan', 'income']) qc.invalidateQueries({ queryKey: [k] });
  };

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch<Tx>(`/transactions/${id}`, body),
    onSuccess: async (_res, { id, body }) => {
      invalidate();
      // offer "apply to all similar" for category / business / member edits
      if ('categoryId' in body || 'businessId' in body || 'memberId' in body) {
        const similar = await api.get<{ count: number }>(`/transactions/${id}/similar`);
        const tx = data?.rows.find(r => r.id === id);
        if (similar.count > 0 && tx) setSuggestRule({ tx, patch: body, count: similar.count });
      }
    },
  });

  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/transactions/bulk', { ids: [...selected], patch: body }),
    onSuccess: () => { invalidate(); setSelected(new Set()); },
  });

  const createRule = useMutation({
    mutationFn: ({ tx, patchBody }: { tx: Tx; patchBody: Record<string, unknown> }) => api.post<{ applied: number }>('/rules', {
      fromTransactionId: tx.id,
      setCategoryId: patchBody.categoryId ?? undefined,
      setBusinessId: patchBody.businessId ?? undefined,
      setBusinessSharePct: patchBody.businessSharePct ?? undefined,
      setMemberId: patchBody.memberId ?? undefined,
    }),
    onSuccess: () => { invalidate(); setSuggestRule(null); },
  });

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const value = (t: Tx): string | number => {
      switch (sort.key) {
        case 'date': return t.effectiveDate;
        case 'description': return t.description;
        case 'amount': return t.amount;
        case 'category': return t.categoryName ?? '';
        case 'member': return member(t.memberId)?.name ?? '';
        case 'business': return business(t.businessId)?.name ?? '';
        case 'account': return t.accountName ?? '';
      }
    };
    return list.sort((a, b) => {
      const va = value(a), vb = value(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'he');
      return (cmp || b.id - a.id) * sort.dir;
    });
  }, [data, sort, member, business]);
  const sortHeader = (key: SortKey, label: string, className = '') => (
    <th className={`cursor-pointer select-none transition-colors duration-(--duration-fast) hover:text-fg ${sort.key === key ? 'text-fg' : ''} ${className}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'date' || key === 'amount' ? -1 : 1 }))}>
      {label}{sort.key === key && <span className="ms-1 inline-flex align-middle text-fg-subtle">{sort.dir === 1 ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</span>}
    </th>
  );
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  const toggle = (id: number) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const cycles = useMemo(() => cycleOptions(), []);
  const cyclePickerOptions = useMemo<PickerOption[]>(() => [
    { value: '', label: 'כל התקופות' },
    ...cycles.map(c => ({ value: c, label: monthName(c), icon: <CalendarDays /> })),
  ], [cycles]);
  const kindFilterOptions = useMemo<PickerOption[]>(() => [{ value: '', label: 'כל הסוגים' }, ...kindOptions()], []);
  const tagOptions = useMemo<PickerOption[]>(() => [
    { value: '', label: '+ תגית' },
    ...(meta?.tags.filter(t => !t.archived).map(t => ({ value: String(t.id), label: `#${t.name}`, icon: <Hash /> })) ?? []),
  ], [meta]);
  const memberOptions = useMemo<PickerOption[]>(() => (meta?.members ?? []).map(m => ({
    value: String(m.id), label: m.name, icon: <MemberAvatar name={m.name} color={m.color} size={18} />,
  })), [meta]);

  return (
    <>
      <PageHeader title="תנועות" icon={ArrowLeftRight}
        subtitle={data ? <>{data.total} תנועות{cycle && !review ? ` · ${monthName(cycle)}` : ''}</> : undefined}
        actions={<>
          <button className="btn" onClick={() => setShowCategories(true)} disabled={!data}><PieChart />פירוט לפי קטגוריות</button>
          <button className="btn btn-primary" onClick={() => setManual('new')}><Plus />הוספת הוצאה</button>
        </>} />

      {data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat index={0} label="תנועות" icon={Receipt} color="var(--chart-1)"
            value={<AnimatedNumber value={data.total} format={formatCount} className="num" />}
            hint={data.totals.moved > 0 ? <>מתוכן העברות, חסכונות ותשלומי כרטיס <Money value={data.totals.moved} /> — לא נספרים</> : undefined} />
          <Stat index={1} label="הכנסות" icon={ArrowDownLeft} tone="good" value={data.totals.income}
            hint={data.totals.businessIncome > 0 ? <>ועוד <Money value={data.totals.businessIncome} /> הכנסות עסק</> : 'חלק הבית, בלי העברות בין חשבונות'} />
          <Stat index={2} label="הוצאות" icon={ArrowUpRight} tone="bad" value={data.totals.spend}
            hint={<button type="button" className="hover:underline" onClick={() => setShowCategories(true)}>
              {data.totals.businessSpend > 0 ? <>ועוד <Money value={data.totals.businessSpend} /> של העסק · </> : null}לפי קטגוריות ←
            </button>} />
          <Stat index={3} label="נטו" icon={Scale} color="var(--chart-6)"
            value={<Money value={data.totals.income - data.totals.spend} colored animated />} hint="הכנסות פחות הוצאות" />
        </div>
      )}

      {showCategories && data && (
        <Modal wide title={`הוצאות לפי קטגוריה${cycle && !review ? ` — ${monthName(cycle)}` : ''}`} onClose={() => setShowCategories(false)}>
          <CategoryReport rows={data.rows} truncated={data.total > data.rows.length}
            onPick={id => { setCategory(id); setShowCategories(false); }} />
        </Modal>
      )}

      {scrapeBatch && <div className="card mb-4 flex items-center justify-between gap-2 text-sm">
        <span>תנועות שנוספו בסריקה #{scrapeBatch}</span>
        <button className="btn-ghost" onClick={() => setScrapeBatch(null)}>הצג את כל התנועות</button>
      </div>}
      <div className="card mb-4 grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 md:p-4 lg:grid-cols-5">
        {charge ? (
          <div className="input flex items-center justify-between gap-2 border-brand-200 bg-brand-50 py-0 pe-1 text-brand-800 dark:border-brand-700/60 dark:bg-brand-700/20 dark:text-brand-100">
            <span className="truncate">חיוב של {day(charge)}</span>
            <button className="btn-ghost btn-icon min-h-7" onClick={() => setCharge(null)} aria-label="הסר סינון חיוב"><X /></button>
          </div>
        ) : (
          <Picker className="input" value={cycle} onChange={v => setCycle(v ?? '')} disabled={review} options={cyclePickerOptions} placeholder="כל התקופות" searchable={false} />
        )}
        <input className="input" placeholder="חיפוש…" value={search} onChange={e => setSearch(e.target.value)} />
        <CategorySelect value={category} onChange={setCategory} />
        <AccountSelect value={account} onChange={setAccount} emptyLabel="כל החשבונות" />
        <Picker className="input max-sm:col-span-2" value={kind} onChange={v => setKind(v ?? '')} options={kindFilterOptions} placeholder="כל הסוגים" searchable={false} />
        <div className="col-span-full flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-fg-muted">
          <label className="flex min-h-8 items-center gap-2 max-sm:min-h-10"><input type="checkbox" checked={followUp} onChange={e => { setFollowUp(e.target.checked); if (e.target.checked) setCycle(''); }} /> רק למעקב</label>
          <label className="flex min-h-8 items-center gap-2 max-sm:min-h-10"><input type="checkbox" checked={showZero} onChange={e => setShowZero(e.target.checked)} /> הצג תנועות בסכום אפס</label>
          <label className="flex min-h-8 items-center gap-2 max-sm:min-h-10"><input type="checkbox" checked={review} onChange={e => setReview(e.target.checked)} /> רק ללא קטגוריה</label>
          <label className="flex min-h-8 items-center gap-2 max-sm:min-h-10" title="שורות ״ויזה״/״כאל״ בבנק שמשלמות עסקאות שכבר מופיעות בכרטיס">
            <input type="checkbox" checked={hideCardPayments} onChange={e => setHideCardPayments(e.target.checked)} /> הסתר תשלומי כרטיס
          </label>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="card animate-rise-in sticky top-[calc(var(--header-h)+0.5rem)] z-20 mb-3 flex flex-wrap items-center gap-2 border-brand-200 bg-brand-50/95 p-3 shadow-(--shadow-overlay) backdrop-blur-md md:p-3 dark:border-brand-700/60 dark:bg-zinc-900/95">
          <span className="min-w-14 px-1 text-sm font-semibold tabular-nums text-brand-800 dark:text-brand-100">{selected.size} נבחרו</span>
          <CategorySelect className="input w-44 max-sm:w-[calc(50%-0.25rem)]" value={null} onChange={id => bulk.mutate({ categoryId: id })} />
          <MemberSelect className="input w-36 max-sm:w-[calc(50%-0.25rem)]" value={null} emptyLabel="שייך לבן משפחה…" onChange={id => bulk.mutate({ memberId: id })} />
          <BusinessSelect className="input w-40 max-sm:w-[calc(50%-0.25rem)]" value={null} onChange={id => bulk.mutate({ businessId: id })} />
          <Picker className="input w-36 max-sm:w-[calc(50%-0.25rem)]" value="" options={tagOptions} placeholder="+ תגית"
            onChange={v => v && bulk.mutate({ addTagIds: [Number(v)] })} />
          <NewTagInput placeholder="תגית חדשה + Enter" onCreated={t => bulk.mutate({ addTagIds: [t.id] })} />
          <button className="btn" onClick={() => bulk.mutate({ followUp: 1 })}><Flag />סמן למעקב</button>
          <button className="btn" onClick={() => bulk.mutate({ followUp: 0 })}>סיום מעקב</button>
          <button className="btn" onClick={() => bulk.mutate({ excluded: 1 })}><EyeOff />הסתר מהחישובים</button>
          <button className="btn-ghost" onClick={() => setSelected(new Set())}>ביטול</button>
        </div>
      )}

      {(patch.error || bulk.error) && <ErrorBox error={patch.error || bulk.error} />}
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (charge ? (
        <Empty>
          אין עדיין פירוט של החיוב הזה — הכרטיס לא דיווח אילו עסקאות ייכנסו לחיוב של {day(charge)} (הסכום בתחזית הוא הערכה לפי חיובים קודמים).
          <div className="mt-2"><button className="btn" onClick={() => { setCharge(null); setCycle(''); }}>הצג את כל העסקאות בכרטיס</button></div>
        </Empty>
      ) : <Empty><Inbox className="mx-auto mb-2 h-6 w-6 opacity-50" />אין תנועות לתצוגה</Empty>) : (
        <div className="card animate-fade-in scroll-x p-0 max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"><input type="checkbox" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))} /></th>
                {sortHeader('date', 'תאריך')}
                {sortHeader('description', 'תיאור')}
                {sortHeader('amount', 'סכום', 'text-end')}
                {sortHeader('category', 'קטגוריה')}
                {sortHeader('member', 'שייך ל')}
                {sortHeader('business', 'עסק')}
                {sortHeader('account', 'חשבון')}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} className={`transition-opacity ${t.excluded ? 'opacity-40' : ''} ${selected.has(t.id) ? 'bg-selected' : ''}`}>
                  <td><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
                  <td className="whitespace-nowrap text-zinc-500">
                    {day(t.date)}
                    {t.processedDate !== t.date && t.accountKind === 'card' && <div className="text-[11px]">חיוב {day(t.processedDate)}</div>}
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button className={`btn-ghost btn-icon shrink-0 ${t.followUp ? 'text-amber-600' : 'text-muted-foreground'}`}
                        aria-label={t.followUp ? 'סיום מעקב' : 'סמן למעקב'} aria-pressed={t.followUp}
                        disabled={patch.isPending} onClick={() => patch.mutate({ id: t.id, body: { followUp: !t.followUp } })}>
                        <Flag className={t.followUp ? 'fill-current' : ''} />
                      </button>
                      <div className="w-32 truncate font-medium sm:w-auto sm:max-w-72">{t.description}</div>
                    </div>
                    <div className="mt-0.5 flex w-32 flex-wrap items-center gap-1 text-[11px] text-zinc-500 empty:hidden sm:w-auto sm:max-w-72 max-sm:[&_.chip]:whitespace-normal">
                      {t.accountKind === 'manual' && <span className="chip gap-1" title="הוזן ידנית — לא מופיע באף חשבון או כרטיס"><PenLine className="h-3 w-3" />ידני</span>}
                      {t.kind !== 'expense' && <span className="chip">{KIND_LABELS[t.kind] ?? t.kind}</span>}
                      {t.link && t.matchedTxnId && <span className="chip" title="השורה בבנק היא החיוב של עסקה בכרטיס — נספרת פעם אחת">↔ חיוב מיידי של {t.link.description}</span>}
                      {t.link && t.settledByTxnId && <span className="chip" title="העסקה חויבה מיד מחשבון הבנק ולא בחיוב החודשי">↔ חויב מיידית מ{t.link.account} ב-{day(t.link.date)}</span>}
                      {t.installmentTotal && <span className="chip">תשלום {t.installmentNumber}/{t.installmentTotal}</span>}
                      {t.followUp && <span className="chip text-amber-700 dark:text-amber-300">למעקב</span>}
                      {t.status === 'pending' && <span className="chip">ממתין</span>}
                      {t.fixed && <span className="chip">קבוע</span>}
                      {t.paybackTotal > 0 && <span className="chip">הוחזרו <Money value={t.paybackTotal} /></span>}
                      {t.notes && <span title={t.notes}>📝</span>}
                      {t.tagIds.map(id => (
                        <span key={id} className="chip gap-1 border border-brand-200 bg-brand-50 pe-1 text-brand-700 dark:border-brand-700/60 dark:bg-brand-700/25 dark:text-brand-100">
                          <Link to={`/events?id=${id}`} className="hover:underline">#{tag(id)?.name}</Link>
                          <button type="button" className="rounded opacity-60 hover:opacity-100" aria-label={`הסר תגית ${tag(id)?.name ?? ''}`}
                            onClick={() => patch.mutate({ id: t.id, body: { removeTagIds: [id] } })}><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                      <Picker className="chip min-h-5 cursor-pointer border border-dashed border-line px-1.5 text-[11px] text-muted-foreground hover:border-brand-300 hover:text-fg [&_svg]:hidden"
                        value="" aria-label="הוסף תגית" placeholder="+ תגית"
                        options={tagOptions.filter(o => o.value && !t.tagIds.includes(Number(o.value)))}
                        onChange={v => v && patch.mutate({ id: t.id, body: { addTagIds: [Number(v)] } })} />
                    </div>
                  </td>
                  <td className="text-end font-medium whitespace-nowrap"><Money value={t.amount} cents colored /></td>
                  <td className="min-w-44">
                    <CategorySelect className="input py-1" value={t.categoryId} onChange={id => patch.mutate({ id: t.id, body: { categoryId: id } })} />
                  </td>
                  <td className="min-w-28">
                    <Picker className="input py-1" value={String(t.memberId)} options={memberOptions} searchable={false}
                      onChange={v => v && patch.mutate({ id: t.id, body: { memberId: Number(v) } })}
                      style={{ color: member(t.memberId)?.color ?? undefined }} />
                  </td>
                  <td className="min-w-40">
                    <BusinessSelect className="input py-1" value={t.businessId} onChange={id => patch.mutate({ id: t.id, body: { businessId: id } })} />
                    {t.businessId && t.businessAmount !== t.amount && (
                      <div className="text-[11px] text-zinc-500">{business(t.businessId)?.name}: <Money value={t.businessAmount} /></div>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-zinc-500">{t.accountName}</td>
                  <td><button className="btn-ghost btn-icon" aria-label="עריכה" onClick={() => (t.accountKind === 'manual' ? setManual(t) : setEditing(t))}><MoreHorizontal /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suggestRule && (
        <Modal title="להחיל על תנועות דומות?" onClose={() => setSuggestRule(null)} footer={<>
          <button className="btn" onClick={() => setSuggestRule(null)}>רק התנועה הזו</button>
          <button className="btn btn-primary" disabled={createRule.isPending}
            onClick={() => createRule.mutate({ tx: suggestRule.tx, patchBody: suggestRule.patch })}>
            החל על {suggestRule.count} ועל תנועות עתידיות
          </button>
        </>}>
          <p className="text-sm">
            יש עוד {suggestRule.count} תנועות של <b>{suggestRule.tx.description}</b>. אפשר ליצור כלל שיחול עליהן וגם על תנועות חדשות מאותו בית עסק.
            תנועות ששינית ידנית לא ישתנו.
          </p>
        </Modal>
      )}

      {manual && <ManualEntry tx={manual === 'new' ? null : manual} defaultMemberId={params.member ? Number(params.member) : undefined}
        onClose={() => setManual(null)} onSaved={() => { invalidate(); setManual(null); }} />}

      {editing && <TxDrawer tx={editing} onClose={() => setEditing(null)} onSave={body => { patch.mutate({ id: editing.id, body }); setEditing(null); }} />}
    </>
  );
}

function TxDrawer({ tx, onClose, onSave }: { tx: Tx; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const [form, setForm] = useState({
    categoryId: tx.categoryId, memberId: tx.memberId, businessId: tx.businessId,
    businessSharePct: tx.businessId ? Math.round((tx.businessAmount / (tx.amount || 1)) * 100) : 100,
    followUp: tx.followUp ? 1 : 0, kind: tx.kind, fixedOverride: tx.fixed ? 1 : 0, excluded: tx.excluded ? 1 : 0, notes: tx.notes ?? '', tagIds: tx.tagIds,
  });
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  return (
    <Modal title={tx.description} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>ביטול</button>
      <button className="btn btn-primary" onClick={() => onSave(form)}>שמור</button>
    </>}>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><div className="label">סכום</div><Money value={tx.amount} cents colored /></div>
        <div><div className="label">תאריך / חיוב</div>{day(tx.date)} / {day(tx.processedDate)}</div>
      </div>
      <Field label="קטגוריה"><CategorySelect value={form.categoryId} onChange={categoryId => set({ categoryId })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="שייך ל"><MemberSelect value={form.memberId} onChange={memberId => set({ memberId: memberId ?? tx.memberId })} /></Field>
        <Field label="סוג">
          <Picker className="input" value={form.kind} options={kindOptions()} searchable={false} onChange={v => v && set({ kind: v })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="עסק"><BusinessSelect value={form.businessId} onChange={businessId => set({ businessId })} /></Field>
        <Field label="חלק עסקי (%)">
          <input className="input" type="number" min={0} max={100} disabled={!form.businessId} value={form.businessSharePct}
            onChange={e => set({ businessSharePct: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="תגיות"><TagPicker value={form.tagIds} onChange={tagIds => set({ tagIds })} /></Field>
      <Field label="הערות"><textarea className="input" rows={2} value={form.notes} onChange={e => set({ notes: e.target.value })} /></Field>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={!!form.followUp} onChange={e => set({ followUp: e.target.checked ? 1 : 0 })} /> דורש טיפול ומעקב</label>
        <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={!!form.fixedOverride} onChange={e => set({ fixedOverride: e.target.checked ? 1 : 0 })} /> הוצאה קבועה</label>
        <label className="flex min-h-8 items-center gap-2"><input type="checkbox" checked={!!form.excluded} onChange={e => set({ excluded: e.target.checked ? 1 : 0 })} /> הסתר מהחישובים</label>
      </div>
    </Modal>
  );
}
