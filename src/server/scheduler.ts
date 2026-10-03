import cron, { type ScheduledTask } from 'node-cron';
import type { DB } from '../db/connection.js';

/**
 * The daily scrape of the desktop app. Settings:
 *   scrape_time     'HH:MM' local time; missing or empty = off
 *   scrape_catch_up '1' (default) = scrape on start / wake when today's time already passed and it didn't run
 */

const setting = (db: DB, key: string): string | undefined =>
  db.prepare(`SELECT value FROM settings WHERE key = ?`).pluck().get(key) as string | undefined;

export function scrapeTime(db: DB): { hour: number; minute: number } | null {
  const m = setting(db, 'scrape_time')?.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** The latest scheduled moment at or before `now` (today at the time, or yesterday's). */
export function lastDueAt(time: { hour: number; minute: number }, now = new Date()): Date {
  const due = new Date(now);
  due.setHours(time.hour, time.minute, 0, 0);
  if (due > now) due.setDate(due.getDate() - 1);
  return due;
}

export interface Scheduler {
  /** after scrape_time changed */
  reschedule(): void;
  /** on start and when the computer wakes: run if the last scheduled time was missed */
  runIfMissed(): void;
  stop(): void;
}

export function startScheduler(db: DB, scrape: () => Promise<unknown>): Scheduler {
  let task: ScheduledTask | null = null;
  const run = (why: string) => {
    console.log(`[${new Date().toISOString()}] scheduled scrape (${why})`);
    // a scrape the user already started is fine: it's the same scrape (409)
    scrape().catch(err => { if ((err as { statusCode?: number }).statusCode !== 409) console.error('scheduled scrape failed:', err); });
  };

  const reschedule = () => {
    task?.stop();
    task = null;
    const time = scrapeTime(db);
    if (time) task = cron.schedule(`${time.minute} ${time.hour} * * *`, () => run('daily'));
  };

  const runIfMissed = () => {
    const time = scrapeTime(db);
    if (!time || setting(db, 'scrape_catch_up') === '0') return;
    const lastStart = db.prepare(`SELECT MAX(started_at) FROM scrape_runs`).pluck().get() as string | null;
    if (!lastStart || new Date(lastStart) < lastDueAt(time)) run('missed');
  };

  reschedule();
  return { reschedule, runIfMissed, stop: () => task?.stop() };
}
