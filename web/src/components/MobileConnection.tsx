import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LoaderCircle, Smartphone } from 'lucide-react';
import { api } from '../api';
import { ErrorBox } from './ui';

interface MobileState {
  status: 'off' | 'starting' | 'ready' | 'failed'; url: string | null; code: string | null;
  expiresAt: string | null; error: string | null; quickTunnel: boolean;
}

export function MobileConnection() {
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
  const qc = useQueryClient();
  const [copyError, setCopyError] = useState(false);
  const state = useQuery({ queryKey: ['mobile'], enabled: local, queryFn: () => api.get<MobileState>('/mobile'), refetchInterval: 2000 });
  const change = useMutation({
    mutationFn: (action: 'start' | 'stop') => api.post<MobileState>(`/mobile/${action}`, {}),
    onSuccess: data => qc.setQueryData(['mobile'], data),
  });
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyError(false); } catch { setCopyError(true); }
  };
  const data = state.data;
  const active = data?.status === 'ready' || data?.status === 'starting';
  if (!local) return <p className="text-sm">מנהלים את חיבור הנייד מתוך האפליקציה במחשב.</p>;
  return <div className="max-w-xl space-y-3 text-sm">
    <p>סורקים את ה־QR בנייד ומזינים קוד גישה בן 6 ספרות. החיבור פעיל עד 12 שעות, כל עוד המחשב והאפליקציה פועלים.</p>
    <p className="text-muted-foreground">נדרשת התקנת cloudflared במחשב. בחיבור פעיל הנתונים עוברים דרך Cloudflare.</p>
    {active && <div className="space-y-3 rounded-lg border p-3">
      {data.status === 'starting' ? <p className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />מכין חיבור לנייד…</p>
        : <>
          <div className="flex flex-col items-center gap-2 py-2">
            <div className="rounded-xl bg-white p-2">
              <QRCodeSVG value={data.url!} size={192} level="M" marginSize={4}
                title="סרקו לפתיחת FamilyCFO בנייד" role="img" aria-label="QR לפתיחת החיבור בנייד" />
            </div>
            <p className="text-center text-muted-foreground">סרקו עם מצלמת הנייד והזינו את הקוד שמופיע כאן</p>
          </div>
          <div><div className="label">כתובת לפתיחה בנייד</div><div className="flex items-center gap-2">
            <a className="min-w-0 flex-1 break-all underline" href={data.url!} target="_blank" rel="noreferrer" dir="ltr">{data.url}</a>
            <button className="btn-ghost btn-icon" aria-label="העתק כתובת" onClick={() => copy(data.url!)}><Copy /></button>
          </div></div>
          <div><div className="label">קוד גישה · 6 ספרות</div><div className="flex items-center gap-2">
            <code className="select-all font-semibold text-3xl tracking-[0.2em]" dir="ltr">{data.code}</code>
            <button className="btn-ghost btn-icon" aria-label="העתק קוד גישה" onClick={() => copy(data.code!)}><Copy /></button>
          </div></div>
          <p className="text-xs text-muted-foreground">בתוקף עד {new Date(data.expiresAt!).toLocaleString('he-IL')}. רק מי שמחזיק בקוד יכול לגשת לנתונים ולערוך אותם.</p>
          {data.quickTunnel && <p className="text-xs text-muted-foreground">הצ׳אט אינו זמין בחיבור הזמני. לחיבור קבוע עם צ׳אט ניתן להגדיר Named Tunnel לפי המדריך בריפו.</p>}
        </>}
    </div>}
    <button className="btn" disabled={change.isPending || state.isLoading} onClick={() => change.mutate(active ? 'stop' : 'start')}>
      <Smartphone />{active ? 'נתק גישה מהנייד' : 'הפעל חיבור לנייד'}
    </button>
    {copyError && <p role="alert">לא ניתן להעתיק אוטומטית. אפשר לסמן ולהעתיק את הטקסט.</p>}
    {(state.error || change.error || data?.error) && <ErrorBox error={state.error || change.error || new Error(data!.error!)} />}
  </div>;
}
