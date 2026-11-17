import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './kit/dialog';
import { desktop, type PasswordMode } from '../desktop';

/**
 * Only where the computer has no credential store (Linux without a keyring): the app asks for the master password
 * that encrypts the bank logins: once to create it, then whenever a scrape or a change needs them.
 */
export function MasterPasswordDialog() {
  const [mode, setMode] = useState<PasswordMode | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => desktop?.onPasswordRequest(m => { setMode(m); setPassword(''); setConfirm(''); }), []);
  if (!desktop || !mode) return null;

  const creating = mode === 'create';
  const valid = password.length >= 8 && (!creating || password === confirm);
  const answer = (value: string | null) => {
    desktop!.answerPassword(value);
    setMode(null);
    setPassword('');
    setConfirm('');
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) answer(null); }}>
      <DialogContent dir="rtl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" />{creating ? 'בחירת סיסמת-על' : 'סיסמת-על'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'במחשב הזה אין מאגר סיסמאות של המערכת, ולכן פרטי הבנק יוצפנו בסיסמה שתבחר. אין דרך לשחזר אותה. אם תשכח אותה, תצטרך להזין שוב את פרטי הבנק.'
              : 'כדי לקרוא את פרטי הבנק. הסיסמה נשמרת בזיכרון 5 דקות בלבד.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (valid) answer(password); }}>
          {mode === 'retry' && <p className="text-sm text-rose-600">הסיסמה שגויה. נסה שוב.</p>}
          <input className="input" type="password" autoFocus autoComplete={creating ? 'new-password' : 'current-password'} dir="ltr"
            placeholder="לפחות 8 תווים" value={password} onChange={e => setPassword(e.target.value)} />
          {creating && (
            <input className="input" type="password" autoComplete="new-password" dir="ltr" placeholder="שוב, לאימות"
              value={confirm} onChange={e => setConfirm(e.target.value)} />
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={!valid}>{creating ? 'שמירה' : 'פתיחה'}</button>
            <button className="btn" type="button" onClick={() => answer(null)}>ביטול</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
