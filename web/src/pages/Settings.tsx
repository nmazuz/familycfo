import { useEffect, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Rule } from '../api';
import { useLookups } from '../state';
import { day } from '../format';
import {
  BellRing, CalendarClock, Coins, KeyRound, Layers, Plus, RefreshCw, Settings2, SlidersHorizontal, Tags, Users, Wallet, Wand2, X,
} from 'lucide-react';
import { desktop } from '../desktop';
import { BankLoginsEditor, LOGINS_SUBTITLE, SCHEDULE_SUBTITLE, ScrapeScheduleForm } from '../components/BankLogins';
import { AccountSelect, CategorySelect, MemberSelect, PageHeader } from '../components/ui';

interface SyncRow { company: string; startedAt: string; success: number; errorType: string | null; errorMessage: string | null; newTransactions: number; lastSuccess: string | null }
interface FxRow { currency: string; rate_to_ils: number; date: string; source: string }

export default function Settings() {
  const qc = useQueryClient();
  const { meta, category } = useLookups();
  const refresh = (...keys: string[]) => { for (const k of ['meta', ...keys]) qc.invalidateQueries({ queryKey: [k] }); };
  const patch = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => api.patch(path, body),
    onSuccess: () => refresh('summary', 'forecast', 'scheduled', 'transactions'),
  });
  const create = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => api.post(path, body),
    onSuccess: () => refresh('scheduled', 'rules'),
  });
  const remove = useMutation({ mutationFn: (path: string) => api.del(path), onSuccess: () => refresh('scheduled', 'rules') });

  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<Rule[]>('/rules') });
  const sync = useQuery({ queryKey: ['sync'], queryFn: () => api.get<SyncRow[]>('/sync-status') });
  const fx = useQuery({ queryKey: ['fx'], queryFn: () => api.get<FxRow[]>('/fx') });
  const pipeline = useMutation({ mutationFn: () => api.post<Record<string, number>>('/pipeline', {}), onSuccess: () => qc.invalidateQueries() });
  const saveSettings = useMutation({ mutationFn: (b: Record<string, string>) => api.put('/settings', b), onSuccess: () => refresh('summary', 'forecast') });

  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);

  if (!meta) return null;
  const banks = meta.accounts.filter(a => a.kind === 'bank');
  const cards = meta.accounts.filter(a => a.kind === 'card');

  return (
    <>
      <PageHeader title="הגדרות" icon={Settings2} actions={
        <button className="btn" disabled={pipeline.isPending} onClick={() => pipeline.mutate()}>
          <RefreshCw className={pipeline.isPending ? 'animate-spin' : ''} />
          {pipeline.isPending ? 'מחשב…' : 'חשב מחדש סיווגים, מנויים והתראות'}
        </button>} />

      <Section title="כללי" icon={SlidersHorizontal} color="var(--chart-1)">
        <div className="grid max-w-4xl gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">יום תחילת מחזור חודשי</span>
            <input className="input num" type="number" min={1} max={28} defaultValue={meta.settings.cycle_start_day}
              onBlur={e => saveSettings.mutate({ cycle_start_day: e.target.value })} />
            <span className="mt-1.5 block text-xs text-zinc-500">למשל 10 אם המשכורת נכנסת ב-10 לחודש</span>
          </label>
          <label className="block">
            <span className="label">כרית ביטחון (יתרה מינימלית רצויה)</span>
            <input className="input num" type="number" step={500} defaultValue={meta.settings.balance_buffer}
              onBlur={e => saveSettings.mutate({ balance_buffer: e.target.value })} />
          </label>
        </div>
      </Section>

      <Section id="members" title="בני הבית" icon={Users} color="var(--chart-6)" subtitle="השמות והצבעים שמופיעים בכל האפליקציה. ״משותף״ הוא ברירת המחדל לחשבונות ותנועות של כל הבית.">
        <div className="grid max-w-3xl gap-2 sm:grid-cols-2">
          {meta.members.map(m => (
            <div key={m.id} className="flex items-center gap-2">
              <input type="color" aria-label={`צבע של ${m.name}`} className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-1"
                defaultValue={m.color ?? '#6b7280'} onBlur={e => e.target.value !== m.color && patch.mutate({ path: `/members/${m.id}`, body: { color: e.target.value } })} />
              <input className="input" defaultValue={m.name} aria-label="שם"
                onBlur={e => e.target.value.trim() && e.target.value !== m.name && patch.mutate({ path: `/members/${m.id}`, body: { name: e.target.value.trim() } })} />
            </div>
          ))}
        </div>
        <button className="btn mt-3" onClick={() => create.mutate({ path: '/members', body: { name: `בן בית ${meta.members.length + 1}`, color: '#16a34a' } })}><Plus />בן בית</button>
      </Section>

      <Section title="חשבונות וכרטיסים" icon={Wallet} color="var(--chart-2)" subtitle="שייכו כל חשבון וכרטיס לבן משפחה, וקבעו מאיזה חשבון בנק משולם כל כרטיס.">
        <div className="scroll-x card-bleed"><table className="table">
          <thead><tr><th>חשבון</th><th>שם תצוגה</th><th>של מי</th><th>משולם מ-</th><th>נסרק לאחרונה</th><th>פעיל</th></tr></thead>
          <tbody>
            {[...banks, ...cards].map(a => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-xs text-zinc-500">{a.kind === 'bank' ? '🏦' : '💳'} {a.id}</td>
                <td className="min-w-40"><input className="input py-1" defaultValue={a.displayName ?? ''} onBlur={e => e.target.value !== a.displayName && patch.mutate({ path: `/accounts/${encodeURIComponent(a.id)}`, body: { displayName: e.target.value } })} /></td>
                <td className="min-w-32"><MemberSelect className="input py-1" value={a.ownerMemberId} emptyLabel="משותף" onChange={id => patch.mutate({ path: `/accounts/${encodeURIComponent(a.id)}`, body: { ownerMemberId: id } })} /></td>
                <td className="min-w-40">{a.kind === 'card' ? (
                  <AccountSelect className="input py-1" kind="bank" value={a.billingBankAccountId} emptyLabel="זיהוי אוטומטי"
                    onChange={id => patch.mutate({ path: `/accounts/${encodeURIComponent(a.id)}`, body: { billingBankAccountId: id } })} />
                ) : '—'}</td>
                <td className="whitespace-nowrap text-xs text-zinc-500">{day(a.lastScrapedAt)}</td>
                <td><input type="checkbox" checked={!!a.active} onChange={e => patch.mutate({ path: `/accounts/${encodeURIComponent(a.id)}`, body: { active: e.target.checked ? 1 : 0 } })} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="הכנסות והוצאות קבועות" icon={CalendarClock} color="var(--chart-3)">
        <p className="text-sm">עברו לעמוד <Link className="text-brand-600 hover:underline" to="/fixed#scheduled">קבועות החודש</Link> — שם מנהלים את כל ההוצאות הקבועות, ההכנסות הקבועות ואומדני חיובי הכרטיסים.</p>
      </Section>

      <Section title="קטגוריות" icon={Layers} color="var(--chart-4)">
        <p className="text-sm">ניהול קטגוריות, קטגוריות אב, מיזוג ומחיקה — <Link className="text-brand-600 hover:underline" to="/categories">בעמוד הקטגוריות</Link>.</p>
      </Section>

      <Section title="כללי סיווג" icon={Wand2} color="var(--chart-5)" subtitle="נוצרים כשבוחרים ״החל על תנועות דומות״. חלים על תנועות חדשות בכל סריקה.">
        {(rules.data ?? []).length === 0 ? <div className="text-sm text-zinc-500">אין כללים עדיין</div> : (
          <div className="scroll-x card-bleed"><table className="table">
            <thead><tr><th>כשהתיאור</th><th>קטגוריה</th><th>עסק</th><th>שייך ל</th><th /></tr></thead>
            <tbody>
              {rules.data!.map(r => (
                <tr key={r.id}>
                  <td>{r.matchType === 'exact' ? 'שווה ל' : 'מכיל'} <b>{r.pattern}</b></td>
                  <td>{category(r.setCategoryId)?.name ?? '—'}</td>
                  <td>{meta.businesses.find(b => b.id === r.setBusinessId)?.name ?? '—'}{r.setBusinessSharePct && r.setBusinessSharePct !== 100 ? ` (${r.setBusinessSharePct}%)` : ''}</td>
                  <td>{meta.members.find(m => m.id === r.setMemberId)?.name ?? '—'}</td>
                  <td><button className="btn-ghost text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => remove.mutate(`/rules/${r.id}`)}>מחק</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <RuleForm onCreate={body => create.mutate({ path: '/rules', body })} />
      </Section>

      <Section title="תגיות" icon={Tags} color="var(--chart-6)">
        <div className="flex flex-wrap gap-2">
          {meta.tags.map(t => (
            <span key={t.id} className="chip min-h-7 gap-1 pe-1">#{t.name}<button type="button" aria-label={`מחק #${t.name}`} className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-zinc-200 hover:text-fg dark:hover:bg-zinc-700" onClick={() => remove.mutate(`/tags/${t.id}`)}><X className="h-3 w-3" /></button></span>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <input className="input w-60 max-sm:flex-1" placeholder="תגית חדשה (למשל: חופשה-יוון)" value={newTag} onChange={e => setNewTag(e.target.value)} />
          <button className="btn" disabled={!newTag.trim()} onClick={() => { create.mutate({ path: '/tags', body: { name: newTag.trim() } }); setNewTag(''); }}><Plus />הוסף</button>
        </div>
      </Section>

      {desktop && (
        <Section id="bank-logins" title="חשבונות בנק וכרטיסי אשראי" icon={KeyRound} color="var(--chart-2)" subtitle={LOGINS_SUBTITLE}>
          <BankLoginsEditor />
        </Section>
      )}
      {desktop && (
        <Section id="schedule" title="סריקה אוטומטית והתראות" icon={BellRing} color="var(--chart-3)" subtitle={SCHEDULE_SUBTITLE}>
          <ScrapeScheduleForm settings={meta.settings} save={b => saveSettings.mutate(b)} />
          <p className="mt-3 text-xs text-zinc-500">FamilyCFO {desktop.version} · <Link className="underline" to="/welcome">אשף ההגדרה</Link></p>
        </Section>
      )}

      <Section title="מצב סריקות" icon={RefreshCw} color="var(--chart-7)">
        <div className="scroll-x card-bleed"><table className="table">
          <thead><tr><th>חברה</th><th>סריקה אחרונה</th><th>תוצאה</th><th>הצלחה אחרונה</th><th className="text-end">חדשות</th></tr></thead>
          <tbody>
            {sync.data?.map(s => (
              <tr key={s.company}>
                <td>{s.company}</td><td className="text-xs">{day(s.startedAt)}</td>
                <td>{s.success ? <span className="text-emerald-600">✓</span> : <span className="text-rose-600" title={s.errorMessage ?? ''}>✗ {s.errorType}</span>}</td>
                <td className="text-xs">{day(s.lastSuccess)}</td><td className="text-end">{s.newTransactions}</td>
              </tr>
            ))}
            {!sync.data?.length && <tr><td colSpan={5} className="text-sm text-zinc-500">עוד לא נרשמו סריקות (מתחיל מהסריקה הבאה)</td></tr>}
          </tbody>
        </table></div>
      </Section>

      <Section title="שערי מטבע" icon={Coins} color="var(--chart-8)" subtitle="מתעדכנים אוטומטית מבנק ישראל בכל סריקה. אפשר לעדכן ידנית.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {fx.data?.filter(r => ['USD', 'EUR', 'GBP', 'CHF'].includes(r.currency)).map(r => (
            <label key={r.currency} className="block">
              <span className="label">{r.currency} · {day(r.date)}</span>
              <input className="input num" type="number" step="0.0001" defaultValue={r.rate_to_ils}
                onBlur={e => Number(e.target.value) !== r.rate_to_ils && api.put('/fx', { currency: r.currency, rate: Number(e.target.value) }).then(() => refresh('fx', 'networth'))} />
            </label>
          ))}
        </div>
      </Section>

      {pipeline.data && <div role="status" className="card animate-rise-in fixed bottom-[max(1rem,env(safe-area-inset-bottom))] start-4 z-40 max-w-[calc(100vw-2rem)] py-3 text-sm shadow-(--shadow-overlay) md:py-3">עודכן: {Object.entries(pipeline.data).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
    </>
  );
}

function Section({ id, title, subtitle, icon: Icon, color, children }: {
  id?: string; title: string; subtitle?: string; icon?: ComponentType<{ className?: string }>; color?: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className="card animate-rise-in mb-4 scroll-mt-20">
      <div className="flex min-h-7 items-center gap-2.5">
        {Icon && <span className="icon-tile h-7 w-7 rounded-lg [&_svg]:h-4 [&_svg]:w-4" style={{ ['--tile' as string]: color ?? 'var(--primary)' }}><Icon /></span>}
        <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
      </div>
      {subtitle && <p className={`mb-4 mt-1 max-w-3xl text-sm leading-relaxed text-zinc-500 ${Icon ? 'sm:ps-[2.375rem]' : ''}`}>{subtitle}</p>}
      <div className={subtitle ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}

function RuleForm({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [memberId, setMemberId] = useState<number | null>(null);
  return (
    <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line-soft pt-4">
      <label className="max-sm:w-full"><span className="label">תיאור מכיל</span><input className="input w-48 max-sm:w-full" value={pattern} onChange={e => setPattern(e.target.value)} /></label>
      <label className="max-sm:min-w-0 max-sm:flex-1"><span className="label">קטגוריה</span><CategorySelect className="input w-48 max-sm:w-full" value={categoryId} onChange={setCategoryId} /></label>
      <label className="max-sm:min-w-0 max-sm:flex-1"><span className="label">שייך ל</span><MemberSelect className="input w-36 max-sm:w-full" value={memberId} emptyLabel="—" onChange={setMemberId} /></label>
      <button className="btn max-sm:w-full" disabled={!pattern.trim() || (!categoryId && !memberId)}
        onClick={() => { onCreate({ pattern: pattern.trim(), setCategoryId: categoryId, setMemberId: memberId }); setPattern(''); }}>
        הוסף כלל
      </button>
      <span className="self-center text-xs text-zinc-500">דוגמה: ״ארומה״ → מסעדות ובתי קפה</span>
    </div>
  );
}
