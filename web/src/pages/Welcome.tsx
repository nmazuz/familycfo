import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BellRing, KeyRound, PartyPopper, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { api } from '../api';
import { useMeta } from '../state';
import { desktop, type BankLoginInfo } from '../desktop';
import { BankLoginsEditor, LOGINS_SUBTITLE, SCHEDULE_SUBTITLE, ScrapeScheduleForm } from '../components/BankLogins';
import { PageHeader } from '../components/ui';
import { cn } from '@/lib/utils';

const STEPS = [
  { title: 'ברוכים הבאים', icon: Sparkles },
  { title: 'בני הבית', icon: Users },
  { title: 'חשבונות', icon: KeyRound },
  { title: 'סריקה והתראות', icon: BellRing },
  { title: 'סיום', icon: PartyPopper },
];

/** First run of the desktop app: members → bank logins (checked one by one) → daily scrape → the first scrape. */
export default function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const [step, setStep] = useState(0);
  const [logins, setLogins] = useState<BankLoginInfo[]>([]);
  const onLogins = useCallback((l: BankLoginInfo[]) => setLogins(l), []);
  const store = useQuery({ queryKey: ['bank-logins-store'], queryFn: () => desktop!.bankLogins.store(), enabled: !!desktop });
  const saveSettings = useMutation({
    mutationFn: (b: Record<string, string>) => api.put('/settings', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta'] }),
  });
  const renameMember = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.patch(`/members/${id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta'] }),
  });
  const finish = async (scrape: boolean) => {
    await api.put('/settings', { onboarding_done: '1' });
    await qc.invalidateQueries({ queryKey: ['meta'] });
    if (scrape) await api.post('/scrape', {}).catch(() => null);
    navigate('/');
  };

  if (!desktop || !meta) return null;
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  return (
    <>
      <PageHeader title="הגדרה ראשונה" icon={Sparkles} subtitle="כמה דקות, ואפשר להתחיל" actions={
        <button className="btn-ghost" onClick={() => finish(false)}>דילוג</button>} />

      <ol className="mb-6 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <button type="button" onClick={() => setStep(i)} className={cn('btn min-h-8 gap-1.5 px-3', i === step ? 'btn-primary' : i < step ? 'text-emerald-700 dark:text-emerald-400' : 'text-fg-subtle')}>
              <s.icon className="h-3.5 w-3.5" />{s.title}
            </button>
          </li>
        ))}
      </ol>

      <section className="card animate-rise-in max-w-4xl">
        {step === 0 && (
          <div className="space-y-3 text-sm leading-relaxed">
            <h2 className="text-lg font-semibold">FamilyCFO רץ כולו על המחשב הזה</h2>
            <p>האפליקציה מתחברת לבנקים ולכרטיסי האשראי שלך, מורידה את התנועות ושומרת אותן כאן בלבד. אין שרת בענן ואין חשבון משתמש.</p>
            <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>פרטי הכניסה לבנקים נשמרים מוצפנים ב-<b>{store.data?.name ?? 'מאגר הסיסמאות של המערכת'}</b>. הם נקראים רק כשסורקים, ונשלחים רק לאתר הבנק עצמו.</span></p>
            {store.data?.backend === 'password' && (
              <p className="rounded-lg bg-amber-50/70 p-3 dark:bg-amber-500/10">במחשב הזה אין מאגר סיסמאות של המערכת (למשל GNOME Keyring או KWallet). לכן כשתשמור את החשבון הראשון תתבקש לבחור סיסמת-על, וכל סריקה תבקש אותה.</p>
            )}
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold">מי בבית?</h2>
            <p className="mb-4 text-sm text-zinc-500">השמות מופיעים בכל האפליקציה. אפשר לשייך כל חשבון וכל תנועה לאחד מהם, או ל״משותף״. אפשר לשנות אחר כך בהגדרות.</p>
            <div className="grid max-w-xl gap-2 sm:grid-cols-2">
              {meta.members.map(m => (
                <input key={m.id} className="input" defaultValue={m.name} aria-label="שם"
                  onBlur={e => e.target.value.trim() && e.target.value !== m.name && renameMember.mutate({ id: m.id, name: e.target.value.trim() })} />
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold">חשבונות בנק וכרטיסי אשראי</h2>
            <p className="mb-4 text-sm text-zinc-500">{LOGINS_SUBTITLE} אחרי השמירה האפליקציה מתחברת פעם אחת כדי לוודא שהפרטים נכונים. אם הבנק שולח קוד ב-SMS, הזן אותו כאן.</p>
            <BankLoginsEditor onChange={onLogins} />
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold">סריקה אוטומטית והתראות</h2>
            <p className="mb-4 text-sm text-zinc-500">{SCHEDULE_SUBTITLE}</p>
            <ScrapeScheduleForm settings={meta.settings} save={b => saveSettings.mutate(b)} />
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm">
            <h2 className="text-lg font-semibold">הכול מוכן</h2>
            <p>{logins.length
              ? `${logins.length} חשבונות שמורים. הסריקה הראשונה מורידה 3 חודשים אחורה ולוקחת כמה דקות.`
              : 'עוד לא נשמרו חשבונות. אפשר להוסיף אותם בכל זמן בהגדרות.'}</p>
            <div className="flex flex-wrap gap-2">
              {!!logins.length && <button className="btn btn-primary" onClick={() => finish(true)}>סריקה ראשונה עכשיו</button>}
              <button className="btn" onClick={() => finish(false)}>מעבר לאפליקציה</button>
            </div>
          </div>
        )}

        {step < STEPS.length - 1 && (
          <div className="mt-6 flex justify-between border-t pt-4">
            <button className="btn-ghost" disabled={step === 0} onClick={back}><ArrowRight className="h-4 w-4" />הקודם</button>
            <button className="btn btn-primary" onClick={next}>הבא<ArrowLeft className="h-4 w-4" /></button>
          </div>
        )}
      </section>
    </>
  );
}
