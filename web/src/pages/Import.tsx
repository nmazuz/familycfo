import { FileUp } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { FileImport } from '../components/FileImport';

/** Monthly upload of statement files, for accounts that aren't connected directly. */
export default function ImportPage() {
  return (
    <>
      <PageHeader title="העלאת קובץ" icon={FileUp} subtitle="פירוט תנועות מהבנק או מחברת האשראי, בלי חיבור ישיר." />
      <section className="card animate-rise-in"><FileImport /></section>
    </>
  );
}
