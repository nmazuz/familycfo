/**
 * What the server tells whoever hosts it — the desktop app turns these into notifications and keeps the Mac awake
 * during a scrape (src/server/desktop.ts → desktop/main.ts). Without a listener they go nowhere.
 */
export type AppEvent =
  | { type: 'scrape-start'; mode: 'scrape' | 'check' }
  | { type: 'otp'; company: string }
  | { type: 'scrape-end'; mode: 'scrape' | 'check'; status: 'done' | 'failed'; newTransactions: number; failed: string[]; error: string | null }
  | { type: 'settings'; keys: string[] };

type Listener = (event: AppEvent) => void;
const listeners = new Set<Listener>();

export function onAppEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitAppEvent(event: AppEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch (err) { console.error('app event listener failed:', err); }
  }
}
