/**
 * The server process of the desktop app: started by desktop/main.ts with fork(), talks to it over the IPC channel.
 * It serves the API and the built UI on 127.0.0.1, asks the main process for the bank logins when a scrape starts
 * (they live encrypted in the Keychain, never in a file or over HTTP), runs the daily scrape and backups, and
 * reports what should become a notification.
 */
import { setConfigProvider } from '../config.js';
import type { Config } from '../scraper.js';
import { importHousehold } from '../db/importData.js';
import { dailyBackup } from '../db/backup.js';
import { getDb } from '../db/connection.js';
import { takeAlertsToNotify } from '../analytics/alerts.js';
import { startServer } from './app.js';
import { startScrape } from './scrapeJob.js';
import { startScheduler } from './scheduler.js';
import { onAppEvent } from './appEvents.js';
import type { MainMessage, ServerMessage } from './desktopProtocol.js';

const send = (msg: ServerMessage) => process.send?.(msg);

// ---- bank logins: on demand from the main process ------------------------------------------------
let nextId = 1;
const pending = new Map<number, { resolve: (c: Config) => void; reject: (e: Error) => void }>();
setConfigProvider(loginIds => new Promise<Config>((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ type: 'credentials-request', id, loginIds });
  // long enough to type a master password (Linux without a keyring)
  setTimeout(() => { if (pending.delete(id)) reject(new Error('the app did not answer with the bank logins')); }, 3 * 60_000);
}));

async function main(): Promise<void> {
  const imported = process.env.HOUSEHOLD_IMPORT_FROM ? await importHousehold(process.env.HOUSEHOLD_IMPORT_FROM) : undefined;

  const webDist = process.env.HOUSEHOLD_WEB_DIST;
  // the usual port keeps the page's origin (its localStorage) stable; if something else took it, any free port
  const { app, port } = await startServer({ port: Number(process.env.PORT ?? 0), webDist }).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return startServer({ port: 0, webDist });
  });
  const db = getDb();
  const enabled = (key: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).pluck().get(key) as string | undefined) !== '0';

  const sendAlerts = () => {
    const alerts = takeAlertsToNotify(db);
    if (alerts.length && enabled('notify_alerts')) send({ type: 'alerts', alerts });
  };

  const scheduler = startScheduler(db, () => startScrape(db));
  onAppEvent(event => {
    if (event.type === 'settings') {
      if (event.keys.includes('scrape_time')) scheduler.reschedule();
      return;
    }
    // the OTP request always notifies: the bank waits only ~90 seconds for the code
    const notify = event.type === 'otp' || (event.type === 'scrape-end' && event.mode === 'scrape' && enabled('notify_scrape'));
    send({ type: 'event', event, notify });
    if (event.type === 'scrape-end' && event.mode === 'scrape') sendAlerts();
  });

  process.on('message', (msg: MainMessage) => {
    if (msg.type === 'credentials') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.config) p.resolve(msg.config); else p.reject(new Error(msg.error ?? 'no bank logins'));
    } else if (msg.type === 'scrape') {
      startScrape(db).catch(err => console.error('scrape not started:', (err as Error).message));
    } else if (msg.type === 'wake') {
      scheduler.runIfMissed();
    } else if (msg.type === 'shutdown') {
      shutdown();
    }
  });

  const backup = () => dailyBackup(db).catch(err => console.error('backup failed:', err));
  await backup();
  setInterval(backup, 6 * 3600_000).unref();
  // alerts also come from edits and "recalculate" in the app, not only from scrapes
  setInterval(sendAlerts, 10 * 60_000).unref();

  const shutdown = () => {
    scheduler.stop();
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  // the main process is gone (crashed or killed): don't keep running without it
  process.on('disconnect', shutdown);

  send({ type: 'ready', port, imported });
  scheduler.runIfMissed();
}

main().catch(err => {
  console.error(err);
  send({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
