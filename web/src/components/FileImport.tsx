import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { read, set_cptable, utils } from 'xlsx';
// Hebrew code pages (windows-1255) for old .xls files and CSVs saved from Excel
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { api } from '../api';
import { MemberSelect } from './ui';
import { COMPANY_LABELS } from './ScrapeButton';
import { FIELD_LABELS, findHeader, toTransactions, type Cell, type Field, type Mapping } from '../lib/statement';
import { money } from '../format';

interface Company { id: string; name: string; kind: 'bank' | 'card' }
interface ImportResult { accountId: string; rows: number; inserted: number; updated: number }

set_cptable(cptable);

/** Excel files carry their own encoding; a CSV is UTF-8 or (saved from Hebrew Excel) windows-1255. */
async function readWorkbook(file: File) {
  const buf = await file.arrayBuffer();
  if (!/\.(csv|txt)$/i.test(file.name)) return read(buf, { cellDates: true });
  let csv: string;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { csv = new TextDecoder('windows-1255').decode(buf); }
  // raw: keep "05/10/2026" as text so it is read day-first, not as a US date
  return read(csv.replace(/^\uFEFF/, ''), { type: 'string', raw: true });
}

const FIELDS: Field[] = ['date', 'description', 'amount', 'debit', 'credit', 'processedDate', 'originalAmount', 'currency', 'memo', 'installments'];

/**
 * Upload a statement file (Excel / CSV exported from the bank's or card company's website) instead of
 * connecting the account. The file is read here in the browser; only the parsed rows go to the local API.
 */
export function FileImport() {
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['setup-companies'], queryFn: () => api.get<Company[]>('/setup/companies') });
  const [companyId, setCompanyId] = useState('max');
  const [label, setLabel] = useState('');
  const [ownerMemberId, setOwnerMemberId] = useState<number | null>(null);
  const [balance, setBalance] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Cell[][]>([]);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [expensesPositive, setExpensesPositive] = useState(true);
  const [error, setError] = useState('');

  const kind = companies.data?.find(c => c.id === companyId)?.kind ?? 'card';
  const parsed = rows.length ? toTransactions(rows, headerIndex, mapping, expensesPositive) : null;

  async function onFile(file: File | undefined) {
    setError(''); setRows([]); upload.reset();
    if (!file) return;
    setFileName(file.name);
    try {
      const wb = await readWorkbook(file);
      // the sheet with the most rows is the statement (some exports add a summary sheet)
      const sheets = wb.SheetNames.map(n => utils.sheet_to_json<Cell[]>(wb.Sheets[n], { header: 1, raw: true, defval: null }));
      const all = sheets.sort((a, b) => b.length - a.length)[0] ?? [];
      const header = findHeader(all);
      setRows(all);
      if (header) { setHeaderIndex(header.index); setMapping(header.mapping); }
      else { setHeaderIndex(0); setMapping({}); setError('לא זיהיתי את הכותרות אוטומטית — בחרו למטה איזו עמודה היא מה.'); }
      // a separate debit/credit pair already carries the sign; a single column on a card statement is purchases-positive
      setExpensesPositive(kind === 'card');
    } catch (e) {
      setError(`לא הצלחתי לקרוא את הקובץ: ${(e as Error).message}`);
    }
  }

  const upload = useMutation({
    mutationFn: () => api.post<ImportResult>('/import', {
      companyId, accountLabel: label, ownerMemberId, balance: balance.trim() ? Number(balance) : null, rows: parsed!.rows,
    }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const header = rows[headerIndex] ?? [];
  const columns = header.map((c, i) => ({ i, name: c == null || c === '' ? `עמודה ${i + 1}` : String(c) }));
  const banks = (companies.data ?? []).filter(c => c.kind === 'bank');
  const cards = (companies.data ?? []).filter(c => c.kind === 'card');

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-500">
        היכנסו לאתר הבנק או חברת האשראי, הורידו את פירוט התנועות כקובץ אקסל או CSV, ובחרו אותו כאן. הקובץ נקרא בתוך המחשב שלכם בלבד.
        העלאה חוזרת של אותו קובץ לא יוצרת כפילויות — אפשר להעלות כל חודש קובץ חדש.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-44"><span className="label">בנק / כרטיס</span>
          <select className="input" value={companyId} onChange={e => setCompanyId(e.target.value)}>
            <optgroup label="בנקים">{banks.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
            <optgroup label="כרטיסי אשראי">{cards.map(c => <option key={c.id} value={c.id}>{COMPANY_LABELS[c.id] ?? c.name}</option>)}</optgroup>
          </select>
        </label>
        <label className="min-w-40"><span className="label">{kind === 'bank' ? 'מספר חשבון (או כינוי)' : '4 ספרות אחרונות של הכרטיס'}</span>
          <input className="input" dir="ltr" value={label} onChange={e => setLabel(e.target.value)} placeholder={kind === 'bank' ? '12-345-678901' : '1234'} />
        </label>
        <label className="min-w-36"><span className="label">של מי</span>
          <MemberSelect value={ownerMemberId} emptyLabel="משותף" onChange={setOwnerMemberId} />
        </label>
        {kind === 'bank' && (
          <label className="w-40"><span className="label">יתרה נוכחית (לא חובה)</span>
            <input className="input num" type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} />
          </label>
        )}
        <label className="btn cursor-pointer">
          <FileSpreadsheet />{fileName || 'בחירת קובץ'}
          <input type="file" className="sr-only" accept=".xlsx,.xls,.csv" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>

      {error && <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>}

      {rows.length > 0 && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-28"><span className="label">שורת כותרות</span>
              <input className="input num" type="number" min={1} max={rows.length} value={headerIndex + 1}
                onChange={e => setHeaderIndex(Math.max(0, Math.min(rows.length - 1, Number(e.target.value) - 1)))} />
            </label>
            {FIELDS.map(f => (
              <label key={f} className="min-w-32"><span className="label">{FIELD_LABELS[f]}</span>
                <select className="input py-1" value={mapping[f] ?? ''}
                  onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value === '') delete n[f]; else n[f] = Number(e.target.value); return n; })}>
                  <option value="">—</option>
                  {columns.map(c => <option key={c.i} value={c.i}>{c.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          {mapping.amount != null && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={expensesPositive} onChange={e => setExpensesPositive(e.target.checked)} />
              בקובץ הזה הוצאות מופיעות כמספר חיובי (רגיל בפירוט כרטיס אשראי)
            </label>
          )}

          {parsed && parsed.rows.length > 0 ? (
            <>
              <div className="text-sm">
                נמצאו <b className="num">{parsed.rows.length}</b> תנועות
                {parsed.skipped > 0 && <span className="text-zinc-500"> · {parsed.skipped} שורות דולגו (סיכומים / שורות ריקות)</span>}
                {' · '}הוצאות {money(-parsed.rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0))}
                {' · '}הכנסות {money(parsed.rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0))}
              </div>
              <div className="scroll-x card-bleed max-h-72 overflow-y-auto"><table className="table">
                <thead><tr><th>תאריך</th><th>תיאור</th><th className="text-end">סכום</th><th>חיוב</th><th>תשלומים</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="num whitespace-nowrap text-xs">{r.date}</td>
                      <td>{r.description}</td>
                      <td className={`num text-end ${r.amount < 0 ? '' : 'text-emerald-600'}`}>{money(r.amount)}{r.currency && r.currency !== 'ILS' ? ` (${r.currency})` : ''}</td>
                      <td className="num whitespace-nowrap text-xs">{r.processedDate ?? ''}</td>
                      <td className="num text-xs">{r.installmentTotal ? `${r.installmentNumber}/${r.installmentTotal}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              {parsed.rows.length > 50 && <div className="text-xs text-zinc-500">מוצגות 50 הראשונות</div>}
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-primary" disabled={!label.trim() || upload.isPending} onClick={() => upload.mutate()}>
                  <Upload />{upload.isPending ? 'מעלה ומסווג…' : `העלה ${parsed.rows.length} תנועות`}
                </button>
                {!label.trim() && <span className="text-sm text-amber-700 dark:text-amber-400">מלאו מספר חשבון / 4 ספרות כדי לזהות את החשבון</span>}
                {upload.data && <span className="text-sm text-emerald-700 dark:text-emerald-400">נוספו {upload.data.inserted} תנועות חדשות{upload.data.rows - upload.data.inserted > 0 ? ` (${upload.data.rows - upload.data.inserted} כבר היו)` : ''} ✓</span>}
                {upload.error && <span className="text-sm text-rose-600">{(upload.error as Error).message}</span>}
              </div>
            </>
          ) : <p className="text-sm text-zinc-500">לא נמצאו תנועות — בדקו את שורת הכותרות ואת בחירת העמודות.</p>}
        </div>
      )}
    </div>
  );
}
