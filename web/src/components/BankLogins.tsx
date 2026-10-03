import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Globe, LoaderCircle, Plus, ShieldCheck, X } from 'lucide-react';
import { api, type ScrapeJob } from '../api';
import { desktop, type BankLoginInfo } from '../desktop';
import { companyName } from './ScrapeButton';

/**
 * The desktop app's bank logins (window.familycfo). Values go to the app, which encrypts them (OS credential store,
 * or a master password where there is none) and never hands them back: this screen only ever sees field names.
 * A new or changed login is checked right away: log in once (with the bank's SMS code if it asks), save nothing.
 */

export const LOGINS_SUBTITLE = 'פרטי הכניסה נשמרים מוצפנים במחשב הזה ומשמשים רק לסריקה. אחרי השמירה הם לא מוצגים שוב, גם לא כאן.';
export const SCHEDULE_SUBTITLE = 'האפליקציה ממשיכה לרוץ ברקע (סמל בשורת התפריטים / מגש המערכת) גם כשהחלון סגור, וסורקת פעם ביום. אם בנק מבקש קוד SMS, תופיע התראה.';

interface Company { id: string; name: string; loginFields: string[] }

const FIELD_LABELS: Record<string, string> = {
  userCode: 'קוד משתמש', username: 'שם משתמש', password: 'סיסמה', id: 'תעודת זהות', nationalID: 'תעודת זהות',
  card6Digits: '6 ספרות של הכרטיס', num: 'מספר מזהה', email: 'אימייל', phoneNumber: 'מספר טלפון',
  otpLongTermToken: 'טוקן OTP קבוע', otpCode: 'קוד OTP',
};
const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;
const isSecret = (field: string) => /pass|otp|token/i.test(field);

type CheckResult = { status: 'ok' } | { status: 'failed'; error: string };

export function BankLoginsEditor({ onChange }: { onChange?: (logins: BankLoginInfo[]) => void }) {
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['scrape-companies'], queryFn: () => api.get<Company[]>('/scrape/companies'), staleTime: Infinity });
  const store = useQuery({ queryKey: ['bank-logins-store'], queryFn: () => desktop!.bankLogins.store() });
  const logins = useQuery({ queryKey: ['bank-logins'], queryFn: () => desktop!.bankLogins.list() });
  const [editing, setEditing] = useState<{ id?: string; companyId: string; label: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [code, setCode] = useState('');

  useEffect(() => { if (logins.data) onChange?.(logins.data); }, [logins.data, onChange]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['bank-logins'] });
  const check = useMutation({
    mutationFn: (loginId: string) => api.post<ScrapeJob>('/scrape/check', { loginId }),
    onMutate: loginId => { qc.removeQueries({ queryKey: ['scrape', 'check'] }); setChecking(loginId); setResults(r => { const { [loginId]: _, ...rest } = r; return rest; }); },
    onError: (err, loginId) => { setChecking(null); setResults(r => ({ ...r, [loginId]: { status: 'failed', error: (err as Error).message } })); },
  });
  const save = useMutation({
    mutationFn: () => desktop!.bankLogins.save({ id: editing!.id, companyId: editing!.companyId, label: editing!.label, credentials: values }),
    onSuccess: saved => {
      setEditing(null);
      setValues({});
      refresh();
      check.mutate(saved.id);
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => desktop!.bankLogins.remove(id), onSuccess: refresh });

  // follow the check: progress, the bank's SMS code, the result
  const job = useQuery({
    queryKey: ['scrape', 'check'],
    queryFn: () => api.get<ScrapeJob>('/scrape'),
    // only once the check started: before that /scrape still shows the previous job
    enabled: checking != null && check.isSuccess,
    refetchInterval: 1000,
  });
  useEffect(() => {
    const j = job.data;
    if (!checking || !check.isSuccess || !j || j.mode !== 'check' || j.status === 'running' || j.status === 'pipeline') return;
    const failed = j.companies.find(c => c.status === 'failed');
    setResults(r => ({ ...r, [checking]: j.status === 'done' ? { status: 'ok' } : { status: 'failed', error: failed?.error ?? j.error ?? 'ההתחברות נכשלה' } }));
    setChecking(null);
  }, [job.data, checking, check.isSuccess]);
  const sendOtp = useMutation({ mutationFn: () => api.post('/scrape/otp', { code }), onSuccess: () => setCode('') });

  const fields = companies.data?.find(c => c.id === editing?.companyId)?.loginFields ?? [];
  // a new login needs every field; an update keeps whatever is left empty
  const complete = editing?.companyId && (editing.id ? true : fields.every(f => values[f]?.trim()));
  const otp = checking && job.data?.mode === 'check' ? job.data.otp : null;

  return (
    <div>
      {store.data && (
        <p className="mb-2 flex items-center gap-2 text-sm text-fg-muted">
          <ShieldCheck className="h-4 w-4 text-emerald-600" /> נשמרים ב: {store.data.name}
        </p>
      )}
      <ScrapeBrowser />

      {!!logins.data?.length && (
        <div className="scroll-x card-bleed mb-4"><table className="table">
          <thead><tr><th>חברה</th><th>תיאור</th><th>שדות שמורים</th><th>בדיקה</th><th /></tr></thead>
          <tbody>
            {logins.data.map(l => {
              const result = results[l.id];
              return (
                <tr key={l.id}>
                  <td>{companyName(l.companyId)}</td>
                  <td>{l.label || '—'}</td>
                  <td className="text-xs text-zinc-500">{l.fields.map(fieldLabel).join(' · ')}</td>
                  <td className="text-sm">
                    {checking === l.id ? <span className="inline-flex items-center gap-1 text-fg-muted"><LoaderCircle className="h-4 w-4 animate-spin" />מתחבר…</span>
                      : result?.status === 'ok' ? <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="h-4 w-4" />מחובר</span>
                      : result?.status === 'failed' ? <span className="inline-flex items-center gap-1 text-rose-600" title={result.error}><X className="h-4 w-4" />{shortError(result.error)}</span>
                      : <button className="btn-ghost" disabled={checking != null} onClick={() => check.mutate(l.id)}>בדיקת חיבור</button>}
                  </td>
                  <td className="text-end whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => { setValues({}); setEditing({ id: l.id, companyId: l.companyId, label: l.label }); }}>עדכון</button>
                    {confirmDelete === l.id
                      ? <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => { setConfirmDelete(null); remove.mutate(l.id); }}>למחוק?</button>
                      : <button className="btn-ghost text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => setConfirmDelete(l.id)}>מחיקה</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}

      {otp && (
        <form className="mb-4 flex max-w-xl flex-wrap items-end gap-2 rounded-lg bg-amber-50/70 p-3 dark:bg-amber-500/10"
          onSubmit={e => { e.preventDefault(); if (code) sendOtp.mutate(); }}>
          <label className="block flex-1 text-sm">
            <span className="label">{companyName(otp.company)} שלח קוד אימות ב-SMS</span>
            <input className="input num" inputMode="numeric" autoComplete="one-time-code" autoFocus dir="ltr" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={!code || sendOtp.isPending}>שליחה</button>
        </form>
      )}

      {logins.data?.length === 0 && !editing && <p className="mb-4 text-sm text-zinc-500">עוד לא נשמרו פרטי כניסה. הסריקה צריכה לפחות חשבון אחד.</p>}

      {editing ? (
        <form className="grid max-w-4xl gap-3 sm:grid-cols-3" autoComplete="off"
          onSubmit={e => { e.preventDefault(); if (complete) save.mutate(); }}>
          <label className="block">
            <span className="label">חברה</span>
            <select className="input" value={editing.companyId} disabled={!!editing.id}
              onChange={e => { setValues({}); setEditing({ ...editing, companyId: e.target.value }); }}>
              <option value="">בחירה…</option>
              {companies.data?.map(c => <option key={c.id} value={c.id}>{companyName(c.id) === c.id ? c.name : companyName(c.id)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">תיאור (לא חובה)</span>
            <input className="input" placeholder="למשל: מקס של דנה" value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })} />
          </label>
          {fields.map(f => (
            <label key={f} className="block">
              <span className="label">{fieldLabel(f)}</span>
              <input className="input" type={isSecret(f) ? 'password' : 'text'} dir="ltr" autoComplete="off" spellCheck={false}
                placeholder={editing.id ? 'ללא שינוי' : ''} value={values[f] ?? ''} onChange={e => setValues({ ...values, [f]: e.target.value })} />
            </label>
          ))}
          <div className="flex flex-wrap items-end gap-2 sm:col-span-3">
            <button className="btn btn-primary" type="submit" disabled={!complete || save.isPending}>{save.isPending ? 'שומר…' : 'שמירה ובדיקת חיבור'}</button>
            <button className="btn" type="button" onClick={() => { setEditing(null); setValues({}); }}>ביטול</button>
            {save.error && <span className="text-sm text-rose-600">{(save.error as Error).message}</span>}
          </div>
        </form>
      ) : (
        <button className="btn" disabled={checking != null} onClick={() => { setValues({}); setEditing({ companyId: '', label: '' }); }}><Plus />הוספת חשבון</button>
      )}
    </div>
  );
}

interface BrowserInfo {
  found: { path: string; source: 'system' | 'downloaded' } | null;
  download: { status: 'idle' | 'downloading' | 'done' | 'failed'; progress: number; error: string | null };
}
const browserName = (path: string) =>
  /edge/i.test(path) ? 'Microsoft Edge' : /chromium/i.test(path) ? 'Chromium' : /testing|chrome-/i.test(path) ? 'Chrome for Testing' : 'Google Chrome';

/** The scraper drives a Chromium browser: an installed one, or (if there is none) one downloaded into the app's data. */
export function ScrapeBrowser() {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['scrape-browser'],
    queryFn: () => api.get<BrowserInfo>('/browser'),
    refetchInterval: q => (q.state.data?.download.status === 'downloading' ? 1000 : false),
  });
  const download = useMutation({
    mutationFn: () => api.post('/browser/download', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scrape-browser'] }),
  });
  const d = info.data;
  if (!d) return null;
  if (d.found) {
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-fg-muted">
        <Globe className="h-4 w-4 text-emerald-600" /> דפדפן לסריקה: {browserName(d.found.path)}{d.found.source === 'downloaded' ? ' (הורד לאפליקציה)' : ''}
      </p>
    );
  }
  const downloading = d.download.status === 'downloading';
  return (
    <div className="mb-4 max-w-2xl space-y-2 rounded-lg bg-amber-50/70 p-3 text-sm dark:bg-amber-500/10">
      <p className="flex items-start gap-2"><Globe className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span>הסריקה צריכה דפדפן Chrome, Chromium או Edge, ולא נמצא אחד במחשב. אפשר להתקין Google Chrome, או להוריד כאן גרסה של Chrome שתשמש רק את האפליקציה (כ-150MB).</span></p>
      {downloading ? (
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div className="h-full bg-primary transition-all" style={{ width: `${d.download.progress}%` }} />
          </div>
          <span className="num text-xs">{d.download.progress}%</span>
        </div>
      ) : (
        <button className="btn" disabled={download.isPending} onClick={() => download.mutate()}><Download className="h-4 w-4" />הורדת דפדפן לסריקה</button>
      )}
      {d.download.status === 'failed' && <p className="text-rose-600">ההורדה נכשלה: {d.download.error}</p>}
    </div>
  );
}

/** The scraper's error types, in words. */
function shortError(error: string): string {
  if (/INVALID_PASSWORD/i.test(error)) return 'פרטי כניסה שגויים';
  if (/CHANGE_PASSWORD/i.test(error)) return 'הבנק מבקש להחליף סיסמה';
  if (/ACCOUNT_BLOCKED/i.test(error)) return 'החשבון חסום';
  if (/TIMEOUT/i.test(error)) return 'הזמן עבר';
  if (/already running/i.test(error)) return 'סריקה אחרת רצה';
  return 'ההתחברות נכשלה';
}

/** The app's daily scrape and its notifications (settings: scrape_time, scrape_catch_up, notify_*). */
export function ScrapeScheduleForm({ settings, save }: { settings: Record<string, string>; save: (b: Record<string, string>) => void }) {
  const [time, setTime] = useState(settings.scrape_time || '07:00');
  const on = !!settings.scrape_time;
  const flag = (key: string) => settings[key] !== '0';
  const toggle = (key: string, label: string) => (
    <label className="flex min-h-8 items-center gap-2 text-sm">
      <input type="checkbox" checked={flag(key)} onChange={e => save({ [key]: e.target.checked ? '1' : '0' })} /> {label}
    </label>
  );
  return (
    <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
      <div>
        <label className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={on} onChange={e => save({ scrape_time: e.target.checked ? time : '' })} /> סריקה יומית בשעה
          <input className="input num w-28" type="time" value={time} disabled={!on}
            onChange={e => setTime(e.target.value)} onBlur={() => on && time !== settings.scrape_time && save({ scrape_time: time })} />
        </label>
        {toggle('scrape_catch_up', 'אם המחשב היה כבוי או ישן בשעה הזו, לסרוק כשהוא חוזר')}
      </div>
      <div>
        {toggle('notify_scrape', 'התראה בסוף כל סריקה')}
        {toggle('notify_alerts', 'התראה על התראות חדשות (חריגה מתקציב, חיוב כפול…)')}
      </div>
    </div>
  );
}
