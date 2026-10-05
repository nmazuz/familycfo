import { useEffect, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, FileSpreadsheet, KeyRound, Plug, Plus, RotateCcw, Save, Shuffle, SlidersHorizontal, Trash2, Users, Wand2 } from 'lucide-react';
import { api } from '../api';
import { useLookups } from '../state';
import { MemberSelect, PageHeader } from '../components/ui';
import { COMPANY_LABELS, ScrapeButton } from '../components/ScrapeButton';
import { FileImport } from '../components/FileImport';
import { cn } from '@/lib/utils';

interface Company { id: string; name: string; kind: 'bank' | 'card'; fields: string[] }
interface SavedLogin { index: number; companyId: string; ownerMemberId: number | null; filled: Record<string, boolean> }
interface LoginRow { key: number; companyId: string; ownerMemberId: number | null; credentials: Record<string, string>; keepFrom: number | null; filled: Record<string, boolean> }

const FIELD_LABELS: Record<string, string> = {
  userCode: 'קוד משתמש', username: 'שם משתמש', password: 'סיסמה', id: 'תעודת זהות', nationalID: 'תעודת זהות',
  card6Digits: '6 ספרות אחרונות של הכרטיס', num: 'קוד מזהה', email: 'אימייל', phoneNumber: 'טלפון',
};
const isSecret = (f: string) => f === 'password';
let nextKey = 1;

type Source = 'connect' | 'upload' | 'both';
const SOURCES: { value: Source; title: string; text: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: 'connect', title: 'חיבור ישיר', icon: Plug, text: 'מזינים פעם אחת את פרטי הכניסה, והאפליקציה מורידה את התנועות לבד בלחיצת כפתור.' },
  { value: 'upload', title: 'העלאת קבצים בלבד', icon: FileSpreadsheet, text: 'בלי לתת סיסמאות: מורידים מאתר הבנק / האשראי קובץ אקסל ומעלים אותו כאן.' },
  { value: 'both', title: 'שילוב', icon: Shuffle, text: 'חלק מהחשבונות בחיבור ישיר וחלק בהעלאת קבצים.' },
];

export default function Setup() {
  const qc = useQueryClient();
  const { meta } = useLookups();
  const refreshAll = () => qc.invalidateQueries();

  const companies = useQuery({ queryKey: ['setup-companies'], queryFn: () => api.get<Company[]>('/setup/companies') });
  const saved = useQuery({ queryKey: ['setup-logins'], queryFn: () => api.get<{ exists: boolean; ready: boolean; canScrape: boolean; logins: SavedLogin[] }>('/setup/logins') });

  // ---- members
  const patchMember = useMutation({ mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`/members/${id}`, body), onSuccess: refreshAll });
  const addMember = useMutation({ mutationFn: () => api.post('/members', { name: `בן בית ${(meta?.members.length ?? 0) + 1}`, color: '#16a34a' }), onSuccess: refreshAll });
  const removeMember = useMutation({ mutationFn: (id: number) => api.del(`/setup/members/${id}`), onSuccess: refreshAll });

  // ---- logins (editable copy of the saved list; passwords are never loaded back)
  const [rows, setRows] = useState<LoginRow[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!saved.data || dirty) return;
    setRows(saved.data.logins.map(l => ({ key: nextKey++, companyId: l.companyId, ownerMemberId: l.ownerMemberId, credentials: {}, keepFrom: l.index, filled: l.filled })));
  }, [saved.data, dirty]);
  const edit = (key: number, patch: Partial<LoginRow>) => { setDirty(true); setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r))); };
  const saveLogins = useMutation({
    mutationFn: () => api.put('/setup/logins', { logins: rows.map(r => ({ companyId: r.companyId, ownerMemberId: r.ownerMemberId, credentials: r.credentials, keepFrom: r.keepFrom })) }),
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ['setup-logins'] }); },
  });
  const fieldsOf = (companyId: string) => companies.data?.find(c => c.id === companyId)?.fields ?? [];
  const missing = rows.some(r => fieldsOf(r.companyId).some(f => !r.credentials[f]?.trim() && !r.filled[f]));

  // ---- general settings
  const saveSettings = useMutation({ mutationFn: (b: Record<string, string>) => api.put('/settings', b), onSuccess: refreshAll });

  // ---- start over
  const [clearLogins, setClearLogins] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.post<{ backup: string }>('/setup/reset', { confirm: true, clearLogins }),
    onSuccess: () => { setDirty(false); refreshAll(); },
  });

  if (!meta) return null;
  const source = (meta.settings.data_source as Source | undefined) ?? 'connect';
  const banks = (companies.data ?? []).filter(c => c.kind === 'bank');
  const cards = (companies.data ?? []).filter(c => c.kind === 'card');

  return (
    <>
      <PageHeader title="הגדרה ראשונית" icon={Wand2} subtitle="ממלאים פעם אחת: מי בבית, אילו חשבונות וכרטיסים יש לכל אחד, ואז מורידים את הנתונים." />

      <Step n={1} title="התחלה מחדש" icon={RotateCcw} color="var(--chart-7)" subtitle="מוחק את כל התנועות, החשבונות, התקציבים וההגדרות ומחזיר את האפליקציה למצב התחלתי. לפני המחיקה נשמר גיבוי בתיקיית backups.">
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn border-rose-300 text-rose-700 dark:text-rose-300" disabled={reset.isPending}
            onClick={() => window.confirm('למחוק את כל הנתונים ולהתחיל מחדש? (נשמר גיבוי)') && reset.mutate()}>
            <RotateCcw />{reset.isPending ? 'מאפס…' : 'התחל מחדש'}
          </button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearLogins} onChange={e => setClearLogins(e.target.checked)} />
            גם למחוק את פרטי הכניסה לבנקים
          </label>
        </div>
        {reset.data && <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">הנתונים נמחקו. גיבוי נשמר ב-{reset.data.backup}</p>}
        {reset.error && <p className="mt-3 text-sm text-rose-600">{(reset.error as Error).message}</p>}
      </Step>

      <Step n={2} title="בני הבית" icon={Users} color="var(--chart-6)" subtitle="השמות והצבעים שיופיעו בכל האפליקציה. ״משותף״ הוא ברירת המחדל לחשבונות של כל הבית.">
        <div className="grid max-w-3xl gap-2 sm:grid-cols-2">
          {meta.members.map(m => (
            <div key={`${m.id}-${m.name}-${m.color}`} className="flex items-center gap-2">
              <input type="color" aria-label={`צבע של ${m.name}`} className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-1"
                defaultValue={m.color ?? '#6b7280'} onBlur={e => e.target.value !== m.color && patchMember.mutate({ id: m.id, body: { color: e.target.value } })} />
              <input className="input" defaultValue={m.name} aria-label="שם"
                onBlur={e => e.target.value.trim() && e.target.value !== m.name && patchMember.mutate({ id: m.id, body: { name: e.target.value.trim() } })} />
              {m.id !== 3 && (
                <button className="btn-ghost btn-icon text-rose-600" aria-label={`הסר את ${m.name}`}
                  onClick={() => window.confirm(`להסיר את ${m.name}?`) && removeMember.mutate(m.id)}><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
        </div>
        <button className="btn mt-3" onClick={() => addMember.mutate()}><Plus />בן בית</button>
        {removeMember.error && <p className="mt-2 text-sm text-rose-600">{(removeMember.error as Error).message}</p>}
      </Step>

      <Step n={3} title="איך להביא את הנתונים?" icon={Shuffle} color="var(--chart-5)" subtitle="אפשר לשנות את הבחירה בכל זמן.">
        <div role="radiogroup" className="grid max-w-4xl gap-2 sm:grid-cols-3">
          {SOURCES.map(o => (
            <button key={o.value} type="button" role="radio" aria-checked={source === o.value}
              className={cn('rounded-lg border p-3 text-start transition-colors', source === o.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-line hover:bg-zinc-50 dark:hover:bg-zinc-800/50')}
              onClick={() => saveSettings.mutate({ data_source: o.value })}>
              <div className="flex items-center gap-2 font-semibold"><o.icon className="h-4 w-4 text-primary" />{o.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-zinc-500">{o.text}</div>
            </button>
          ))}
        </div>
      </Step>

      {source !== 'upload' && <Step n={4} title="חיבור ישיר לבנקים ולכרטיסים" icon={KeyRound} color="var(--chart-2)"
        subtitle="הוסיפו כל בנק וחברת אשראי, בחרו של מי הם והקלידו את פרטי הכניסה. הפרטים נשמרים רק במחשב הזה (בקובץ accounts.json) ולא מוצגים שוב — כדי לא לשנות סיסמה שמורה, השאירו את השדה ריק.">
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.key} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-44 flex-1 sm:flex-none"><span className="label">בנק / כרטיס</span>
                  <select className="input" value={r.companyId}
                    onChange={e => edit(r.key, { companyId: e.target.value, credentials: {}, keepFrom: null, filled: {} })}>
                    <optgroup label="בנקים">{banks.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
                    <optgroup label="כרטיסי אשראי">{cards.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
                  </select>
                </label>
                <label className="min-w-36 flex-1 sm:flex-none"><span className="label">של מי</span>
                  <MemberSelect value={r.ownerMemberId} emptyLabel="משותף" onChange={id => edit(r.key, { ownerMemberId: id })} />
                </label>
                {fieldsOf(r.companyId).map(f => (
                  <label key={f} className="min-w-40 flex-1"><span className="label">{FIELD_LABELS[f] ?? f}</span>
                    <input className="input" dir="ltr" type={isSecret(f) ? 'password' : 'text'} autoComplete="off"
                      placeholder={r.filled[f] ? '•••• שמור' : ''} value={r.credentials[f] ?? ''}
                      onChange={e => edit(r.key, { credentials: { ...r.credentials, [f]: e.target.value } })} />
                  </label>
                ))}
                <button className="btn-ghost btn-icon text-rose-600" aria-label="הסר" onClick={() => { setDirty(true); setRows(rs => rs.filter(x => x.key !== r.key)); }}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn" disabled={!companies.data}
            onClick={() => { setDirty(true); setRows(rs => [...rs, { key: nextKey++, companyId: banks[0]?.id ?? 'hapoalim', ownerMemberId: null, credentials: {}, keepFrom: null, filled: {} }]); }}>
            <Plus />הוסף בנק או כרטיס
          </button>
          <button className="btn btn-primary" disabled={!dirty || missing || saveLogins.isPending} onClick={() => saveLogins.mutate()}>
            <Save />{saveLogins.isPending ? 'שומר…' : 'שמור'}
          </button>
          {dirty && missing && <span className="text-sm text-amber-700 dark:text-amber-400">יש שדות ריקים</span>}
          {!dirty && saveLogins.isSuccess && <span className="text-sm text-emerald-700 dark:text-emerald-400">נשמר ✓</span>}
          {saveLogins.error && <span className="text-sm text-rose-600">{(saveLogins.error as Error).message}</span>}
        </div>
        <div className="mt-5 border-t border-line-soft pt-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><CloudDownload className="h-4 w-4" />הורדת הנתונים</div>
          <p className="mb-3 max-w-3xl text-sm text-zinc-500">לחיצה פותחת חלון דפדפן לכל בנק ומורידה 3 חודשים אחורה. אם הבנק שולח קוד ב-SMS, יופיע שדה להקליד אותו.</p>
          {saved.data?.canScrape ? <ScrapeButton /> : <p className="text-sm text-zinc-500">קודם מלאו ושמרו לפחות בנק או כרטיס אחד.</p>}
        </div>
      </Step>}

      {source !== 'connect' && <Step n={source === 'upload' ? 4 : 5} title="העלאת קבצים" icon={FileSpreadsheet} color="var(--chart-3)">
        <FileImport />
      </Step>}

      <Step n={source === 'both' ? 6 : 5} title="הגדרות כלליות" icon={SlidersHorizontal} color="var(--chart-1)">
        <div className="grid max-w-4xl gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">יום תחילת מחזור חודשי</span>
            <input key={meta.settings.cycle_start_day} className="input num" type="number" min={1} max={28} defaultValue={meta.settings.cycle_start_day}
              onBlur={e => saveSettings.mutate({ cycle_start_day: e.target.value })} />
            <span className="mt-1.5 block text-xs text-zinc-500">למשל 10 אם המשכורת נכנסת ב-10 לחודש</span>
          </label>
          <label className="block">
            <span className="label">כרית ביטחון (יתרה מינימלית רצויה)</span>
            <input key={meta.settings.balance_buffer} className="input num" type="number" step={500} defaultValue={meta.settings.balance_buffer}
              onBlur={e => saveSettings.mutate({ balance_buffer: e.target.value })} />
          </label>
        </div>
      </Step>

    </>
  );
}

function Step({ n, title, subtitle, icon: Icon, color, children }: {
  n: number; title: string; subtitle?: string; icon: ComponentType<{ className?: string }>; color: string; children: React.ReactNode;
}) {
  return (
    <section className="card animate-rise-in mb-4">
      <div className="flex min-h-7 items-center gap-2.5">
        <span className="icon-tile h-7 w-7 rounded-lg [&_svg]:h-4 [&_svg]:w-4" style={{ ['--tile' as string]: color }}><Icon /></span>
        <h2 className="text-[0.9375rem] font-semibold tracking-tight"><span className="num text-zinc-400">{n}.</span> {title}</h2>
      </div>
      {subtitle && <p className="mb-4 mt-1 max-w-3xl text-sm leading-relaxed text-zinc-500 sm:ps-[2.375rem]">{subtitle}</p>}
      <div className={subtitle ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}
