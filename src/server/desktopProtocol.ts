import type { Config } from '../scraper.js';
import type { AppEvent } from './appEvents.js';
import type { AlertNotice } from '../analytics/alerts.js';

/** Messages between the desktop app's main process (desktop/main.ts) and its server process (src/server/desktop.ts). */

export type ServerMessage =
  | { type: 'ready'; port: number; imported?: { db: boolean; documents: string[] } }
  | { type: 'fatal'; error: string }
  | { type: 'credentials-request'; id: number; loginIds?: string[] }
  | { type: 'event'; event: AppEvent; notify: boolean }
  | { type: 'alerts'; alerts: AlertNotice[] };

export type MainMessage =
  | { type: 'credentials'; id: number; config?: Config; error?: string }
  | { type: 'scrape' }
  | { type: 'wake' }
  | { type: 'shutdown' };
