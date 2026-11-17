import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Where things live. From the repo (npm run dev / scrape) both are the current directory, as always; the desktop app
 * (desktop/main.ts) sets HOUSEHOLD_HOME to its user-data folder and HOUSEHOLD_APP_DIR to its bundled resources.
 */

/** The household's own files: bank.db, accounts.json, data/policies, data/reports, backups/. */
export const DATA_DIR = resolve(process.env.HOUSEHOLD_HOME || '.');
export const dataPath = (...parts: string[]) => join(DATA_DIR, ...parts);

/** The app's own files: agent/ (the chat's instructions and skills) and src/agent/guard-read.mjs. */
export const APP_DIR = resolve(process.env.HOUSEHOLD_APP_DIR || fileURLToPath(new URL('..', import.meta.url)));

/** Running inside the desktop app (a Node child of Electron, see desktop/main.ts). */
export const IN_DESKTOP = process.env.HOUSEHOLD_DESKTOP === '1';
