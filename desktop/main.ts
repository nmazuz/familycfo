/**
 * FamilyCFO as a Mac app. The window shows the same UI as `npm run dev`. The server (src/server/desktop.ts: API,
 * built UI, daily scrape, backups) runs as a forked Node process on 127.0.0.1. The window can close; the app keeps
 * running from the menu bar. This process holds the bank logins (Keychain) and turns the server's events into
 * notifications.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import { fork, type ChildProcess } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import electronUpdater from 'electron-updater';
import { findOnPath, loginShellPath, mergePaths } from './shellEnv.js';
import { importAccountsFile, listLogins, removeLogin, saveLogin, scraperConfig, setPasswordPrompt, storeInfo } from './credentials.js';
import type { MainMessage, ServerMessage } from '../src/server/desktopProtocol.js';

const DEV = !app.isPackaged;
app.setName('FamilyCFO');
// Windows: notifications are attributed to the app by this id (the installer's appId)
if (process.platform === 'win32') app.setAppUserModelId('io.familycfo.app');
// `npm run desktop:dev` never touches the installed app's data
if (DEV) app.setPath('userData', join(app.getPath('appData'), 'FamilyCFO (dev)'));
if (!app.requestSingleInstanceLock()) app.exit(0);

/** dev: the repo (this file is build/desktop/main.cjs); packaged: Contents/Resources */
const ROOT = DEV ? join(__dirname, '..', '..') : process.resourcesPath;
const WEB_DIST = DEV ? join(ROOT, 'web', 'dist') : join(ROOT, 'web');
const ASSETS = DEV ? join(ROOT, 'desktop', 'assets') : join(ROOT, 'assets');
// a fixed port keeps the page's origin (and its localStorage) the same between runs; the server falls back to a free one
const PORT = DEV ? 4331 : 4330;
/** the household's files (bank.db, data/, backups/, logs/), apart from Chromium's own files in userData */
const dataDir = () => join(app.getPath('userData'), 'household');
const PATH = mergePaths(loginShellPath(), process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin');

let server: ChildProcess | null = null;
let serverUrl: string | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let restarts = 0;
let scraping = false;
let status = 'מתחיל…';
let awake: number | null = null;

// ---- server process ----------------------------------------------------------------------------------------------

const toServer = (msg: MainMessage) => { if (server?.connected) server.send(msg); };

function startServer(importFrom?: string): void {
  const logDir = join(dataDir(), 'logs');
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, 'server.log'), { flags: 'a' });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH,
    PORT: String(PORT),
    HOUSEHOLD_DESKTOP: '1',
    HOUSEHOLD_HOME: dataDir(),
    HOUSEHOLD_APP_DIR: ROOT,
    HOUSEHOLD_WEB_DIST: WEB_DIST,
    CLAUDE_PATH: process.env.CLAUDE_PATH || findOnPath('claude', PATH) || 'claude',
    ...(importFrom ? { HOUSEHOLD_IMPORT_FROM: importFrom } : {}),
  };
  // the app's own data, not whatever a developer shell had set
  delete env.ACCOUNTS_FILE;
  delete env.ELECTRON_RUN_AS_NODE;

  server = DEV
    // from source, with the system Node (better-sqlite3 is built for it)
    ? fork(join(ROOT, 'src', 'server', 'desktop.ts'), [], {
      cwd: ROOT, env, execPath: findOnPath('node', PATH) ?? 'node', execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    // the bundle, run by Electron's own binary as Node
    : fork(join(__dirname, 'server.mjs'), [], {
      cwd: dataDir(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', HOUSEHOLD_MCP_SCRIPT: join(__dirname, 'mcp.mjs') },
    });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  if (DEV) { server.stdout?.pipe(process.stdout); server.stderr?.pipe(process.stderr); }

  const child = server;
  child.on('message', (msg: ServerMessage) => onServerMessage(child, msg));
  child.on('exit', code => {
    if (server === child) server = null;
    setScraping(false);
    if (quitting) return;
    if (++restarts > 5) {
      dialog.showErrorBox('FamilyCFO', `השרת של האפליקציה נעצר (קוד ${code}). פרטים ב-${join(logDir, 'server.log')}`);
      app.exit(1);
      return;
    }
    setTimeout(() => startServer(), 1000 * restarts);
  });
}

function onServerMessage(child: ChildProcess, msg: ServerMessage): void {
  switch (msg.type) {
    case 'ready': {
      restarts = 0;
      const url = `http://127.0.0.1:${msg.port}`;
      const changed = url !== serverUrl;
      serverUrl = url;
      status = 'מוכן';
      updateTray();
      if (!win) createWindow();
      else if (changed) win.loadURL(url);
      if (msg.imported) showImportResult(msg.imported);
      // accounts.json from the first-run import: now that there is a window (a master password may be needed)
      if (pendingAccountsFile) {
        const path = pendingAccountsFile;
        pendingAccountsFile = null;
        win?.webContents.once('did-finish-load', () => { importAccounts(path); });
      }
      break;
    }
    case 'fatal':
      dialog.showErrorBox('FamilyCFO', `האפליקציה לא הצליחה לעלות: ${msg.error}`);
      break;
    case 'credentials-request': {
      scraperConfig(msg.loginIds)
        .then(config => child.send({ type: 'credentials', id: msg.id, config } satisfies MainMessage))
        .catch(err => child.send({ type: 'credentials', id: msg.id, error: (err as Error).message } satisfies MainMessage));
      break;
    }
    case 'event': {
      const e = msg.event;
      if (e.type === 'scrape-start') {
        if (e.mode === 'scrape') setScraping(true);
      } else if (e.type === 'otp') {
        notify(`${companyName(e.company)} מבקש קוד אימות`, 'הקוד נשלח אליך ב-SMS. יש להזין אותו באפליקציה תוך דקה וחצי.', '/', 'critical');
      } else if (e.type === 'scrape-end' && e.mode === 'check') {
        // a login check from the onboarding / settings screen: the page shows the result itself
      } else if (e.type === 'scrape-end') {
        setScraping(false);
        status = e.status === 'done' ? `סריקה אחרונה: ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}` : 'הסריקה האחרונה נכשלה';
        updateTray();
        if (msg.notify) {
          const failed = e.failed.length ? ` לא נסרקו: ${e.failed.map(companyName).join(', ')}.` : '';
          notify(e.status === 'done' ? 'הסריקה הסתיימה' : 'הסריקה נכשלה',
            e.status === 'done' ? `נוספו ${e.newTransactions} תנועות.${failed}` : (e.error ?? failed), '/');
        }
      }
      break;
    }
    case 'alerts': {
      const shown = msg.alerts.slice(0, 3);
      for (const a of shown) notify(a.title, a.message, '/insights', a.severity === 'critical' ? 'critical' : 'normal');
      if (msg.alerts.length > shown.length) notify(`ועוד ${msg.alerts.length - shown.length} התראות`, 'פרטים בעמוד התובנות.', '/insights');
      break;
    }
  }
}

function setScraping(on: boolean): void {
  scraping = on;
  if (on) {
    status = 'סורק…';
    // keep the Mac from sleeping in the middle of a bank login
    if (awake == null) awake = powerSaveBlocker.start('prevent-app-suspension');
  } else if (awake != null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
  updateTray();
}

const COMPANY_NAMES: Record<string, string> = {
  hapoalim: 'בנק הפועלים', leumi: 'בנק לאומי', discount: 'בנק דיסקונט', mizrahi: 'מזרחי טפחות', mercantile: 'מרכנתיל',
  otsarHahayal: 'אוצר החייל', beinleumi: 'הבינלאומי', massad: 'מסד', yahav: 'יהב', oneZero: 'וואן זירו',
  visaCal: 'כאל', isracard: 'ישראכרט', amex: 'אמריקן אקספרס', max: 'מקס',
};
const companyName = (id: string) => COMPANY_NAMES[id] ?? id;

// ---- window -----------------------------------------------------------------------------------------------------

const ownPage = (url: string) => serverUrl != null && url.startsWith(`${serverUrl}/`);

function createWindow(): void {
  if (!serverUrl) return;
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false, title: 'FamilyCFO',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#fafafa',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win?.show());
  // closing the window hides it; the app (and the daily scrape) keeps running from the menu bar
  win.on('close', e => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // insurance documents (/api/insurance/documents/…/file): a plain viewer window, without the app's bridge
    if (ownPage(url) && new URL(url).pathname.startsWith('/api/')) {
      const viewer = new BrowserWindow({ width: 1000, height: 1200, title: 'FamilyCFO',
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      viewer.loadURL(url);
    } else if (url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (ownPage(url)) return;
    e.preventDefault();
    if (url.startsWith('https://')) shell.openExternal(url);
  });
  win.loadURL(serverUrl);
}

function showWindow(route?: string): void {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) win.webContents.send('navigate', route);
}

// ---- notifications & menu bar -----------------------------------------------------------------------------------

const live = new Set<Notification>(); // a notification that is garbage-collected loses its click handler
function notify(title: string, body: string, route?: string, urgency: 'normal' | 'critical' = 'normal'): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, urgency });
  live.add(n);
  n.on('click', () => { live.delete(n); showWindow(route); });
  n.on('close', () => live.delete(n));
  n.show();
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(`FamilyCFO — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'פתיחת FamilyCFO', click: () => showWindow() },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: scraping ? 'סורק…' : 'סריקה עכשיו', enabled: !scraping && server != null, click: () => toServer({ type: 'scrape' }) },
    { label: 'הגדרות', click: () => showWindow('/settings') },
    { type: 'separator' },
    ...(DEV ? [] : [{ label: 'בדיקת עדכונים', click: () => { checkForUpdates(true); } }]),
    { label: 'יציאה', role: 'quit' as const },
  ]));
}

function createTray(): void {
  // macOS: a monochrome template the menu bar tints; Windows / Linux: the colour icon, small
  let icon;
  if (process.platform === 'darwin') {
    icon = nativeImage.createFromPath(join(ASSETS, 'trayTemplate.png'));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(join(ASSETS, 'icon.png')).resize({ width: process.platform === 'win32' ? 16 : 22 });
  }
  tray = new Tray(icon);
  // the convention: macOS opens the menu, Windows / Linux open the app (the menu is on right-click)
  tray.on('click', () => (process.platform === 'darwin' ? tray?.popUpContextMenu() : showWindow()));
  updateTray();
}

// ---- first run --------------------------------------------------------------------------------------------------

/**
 * No database yet: import an existing household (a folder with bank.db, e.g. where `npm run dev` ran) or start
 * fresh. Asked before the server opens the database; the rest of the setup (members, bank logins, schedule) is
 * the in-app onboarding (/welcome).
 */
let pendingAccountsFile: string | null = null;
async function firstRun(): Promise<string | undefined> {
  if (process.env.BANK_DB || existsSync(join(dataDir(), 'bank.db'))) return undefined;
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['התחלה מאפס', 'ייבוא נתונים קיימים…'], defaultId: 0, cancelId: 0,
    message: 'ברוכים הבאים ל-FamilyCFO',
    detail: 'אם כבר הרצת את FamilyCFO מהקוד, אפשר לייבא את התיקייה שלו: bank.db, מסמכי הביטוח והדוחות, ופרטי הבנק מ-accounts.json (הם יישמרו מוצפנים).',
  });
  if (response !== 1) return undefined;
  const pick = await dialog.showOpenDialog({ title: 'התיקייה עם bank.db', properties: ['openDirectory'] });
  const dir = pick.filePaths[0];
  if (!dir) return undefined;
  if (existsSync(join(dir, 'accounts.json'))) pendingAccountsFile = join(dir, 'accounts.json');
  return dir;
}

async function importAccounts(path: string): Promise<void> {
  try {
    const n = await importAccountsFile(path);
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['הצגה בתיקייה', 'סגירה'], defaultId: 0,
      message: `${n} פרטי כניסה יובאו (${storeInfo().name})`,
      detail: `הקובץ accounts.json עדיין שמור בטקסט גלוי ב-${path}. כדאי למחוק אותו בעצמך (FamilyCFO לא מוחק אותו).`,
    });
    if (response === 0) shell.showItemInFolder(path);
  } catch (err) {
    dialog.showErrorBox('FamilyCFO', `לא הצלחתי לייבא את accounts.json: ${(err as Error).message}`);
  }
}

function showImportResult(imported: { db: boolean; documents: string[] }): void {
  if (!imported.db) dialog.showMessageBox({ type: 'warning', message: 'לא נמצא bank.db בתיקייה שנבחרה', detail: 'האפליקציה התחילה עם מסד נתונים חדש.' });
}

// ---- updates ----------------------------------------------------------------------------------------------------

const { autoUpdater } = electronUpdater;
async function checkForUpdates(manual = false): Promise<string> {
  if (DEV) return 'dev';
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify();
    const version = result?.updateInfo.version;
    const message = version && version !== app.getVersion() ? `גרסה ${version} יורדת ותותקן ביציאה` : 'זו הגרסה העדכנית';
    if (manual) dialog.showMessageBox({ type: 'info', message });
    return message;
  } catch (err) {
    if (manual) dialog.showErrorBox('FamilyCFO', `בדיקת העדכונים נכשלה: ${(err as Error).message}`);
    return 'error';
  }
}

// ---- IPC from the page (window.familycfo, desktop/preload.ts) ---------------------------------------------------

/** Only the app's own window, on the app's own page, may use the bridge. */
function trusted(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return e.sender === win?.webContents && ownPage(e.senderFrame?.url ?? '');
}

ipcMain.on('app:version', e => { e.returnValue = app.getVersion(); });
ipcMain.handle('logins:list', e => (trusted(e) ? listLogins() : []));
ipcMain.handle('logins:store', e => (trusted(e) ? storeInfo() : null));
ipcMain.handle('logins:save', (e, login) => { if (!trusted(e)) throw new Error('denied'); return saveLogin(login); });
ipcMain.handle('logins:remove', (e, id: string) => { if (!trusted(e)) throw new Error('denied'); return removeLogin(String(id)); });

// The master password (only where the OS has no credential store): the page shows a dialog when asked
let passwordWaiter: { resolve: (pw: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
setPasswordPrompt(mode => new Promise<string>((resolve, reject) => {
  passwordWaiter?.reject(new Error('superseded'));
  const timer = setTimeout(() => { passwordWaiter = null; reject(new Error('לא הוזנה סיסמת-על')); }, 150_000);
  passwordWaiter = { resolve, reject, timer };
  if (!win?.isVisible()) notify('FamilyCFO צריך את סיסמת-העל', 'כדי לקרוא את פרטי הבנק לסריקה.');
  showWindow();
  win?.webContents.send('password-request', mode);
}));
ipcMain.handle('logins:password', (e, password: string | null) => {
  if (!trusted(e) || !passwordWaiter) return;
  const { resolve, reject, timer } = passwordWaiter;
  passwordWaiter = null;
  clearTimeout(timer);
  if (typeof password === 'string') resolve(password); else reject(new Error('בוטל'));
});
ipcMain.handle('app:check-updates', e => (trusted(e) ? checkForUpdates() : null));

// ---- lifecycle --------------------------------------------------------------------------------------------------

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
// the menu-bar icon keeps the app alive with no window
app.on('window-all-closed', () => { /* stay running */ });

app.on('before-quit', e => {
  if (quitting && !server) return;
  quitting = true;
  if (server) {
    e.preventDefault();
    const child = server;
    child.once('exit', () => { server = null; app.quit(); });
    toServer({ type: 'shutdown' });
    setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 5000);
  }
});

app.whenReady().then(async () => {
  createTray();
  const importFrom = await firstRun();
  startServer(importFrom);
  powerMonitor.on('resume', () => toServer({ type: 'wake' }));
  if (!DEV) {
    autoUpdater.autoInstallOnAppQuit = true;
    checkForUpdates();
    setInterval(() => checkForUpdates(), 6 * 3600_000);
  }
});
