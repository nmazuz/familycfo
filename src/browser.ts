import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers';
import { dataPath } from './paths.js';

/**
 * The browser the scraper drives. The desktop app doesn't bundle one (~300MB). It uses an installed Chrome /
 * Chromium / Edge. If none is installed, the user can download Chrome for Testing (Google's signed, stable build)
 * into the data folder.
 */

const home = homedir();
const SYSTEM_BROWSERS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    // Edge is Chromium and comes with every Windows
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** Where a downloaded Chrome for Testing lives (inside the data folder, so no admin rights are needed). */
export const BROWSER_DIR = process.env.BROWSER_DIR || dataPath('browser');

export const systemBrowser = (): string | undefined => (SYSTEM_BROWSERS[platform()] ?? []).find(p => existsSync(p));

async function downloadedBrowser(): Promise<string | undefined> {
  if (!existsSync(BROWSER_DIR)) return undefined;
  const installed = await getInstalledBrowsers({ cacheDir: BROWSER_DIR });
  return installed.filter(b => b.browser === Browser.CHROME).map(b => b.executablePath).find(p => existsSync(p));
}

export interface FoundBrowser { path: string; source: 'system' | 'downloaded' }

/** An installed browser first, then a downloaded one; null = the scraper can't run. */
export async function findBrowser(): Promise<FoundBrowser | null> {
  const system = systemBrowser();
  if (system) return { path: system, source: 'system' };
  const downloaded = await downloadedBrowser();
  return downloaded ? { path: downloaded, source: 'downloaded' } : null;
}

export const NO_BROWSER = 'לא נמצא דפדפן לסריקה (Chrome, Chromium או Edge). אפשר להתקין Google Chrome, או להוריד דפדפן מתוך האפליקציה (הגדרות → דפדפן לסריקה).';

// ---- download -------------------------------------------------------------------------------------------------

export interface DownloadState { status: 'idle' | 'downloading' | 'done' | 'failed'; progress: number; error: string | null }
let state: DownloadState = { status: 'idle', progress: 0, error: null };
export const downloadState = (): DownloadState => state;

/** Download Chrome for Testing (stable) in the background; follow it with downloadState(). */
export function startBrowserDownload(): DownloadState {
  if (state.status === 'downloading') return state;
  const platformId = detectBrowserPlatform();
  if (!platformId) throw Object.assign(new Error('this platform has no Chrome for Testing build'), { statusCode: 400 });
  state = { status: 'downloading', progress: 0, error: null };
  (async () => {
    const buildId = await resolveBuildId(Browser.CHROME, platformId, 'stable');
    await install({
      browser: Browser.CHROME, buildId, platform: platformId, cacheDir: BROWSER_DIR,
      downloadProgressCallback: (done, total) => { state.progress = total ? Math.round((done / total) * 100) : 0; },
    });
    state = { status: 'done', progress: 100, error: null };
  })().catch(err => {
    console.error('browser download failed:', err);
    state = { status: 'failed', progress: 0, error: err instanceof Error ? err.message : String(err) };
  });
  return state;
}
