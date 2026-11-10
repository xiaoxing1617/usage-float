// Task list shown in the floating ball's bubbles: running conversations from
// the backend, plus ones that finished while the app was watching, until the
// user removes them. Kept in localStorage so a restart doesn't lose the list.

import type { Activity, RunningTask } from "./api";
import { fmt, type Dict } from "./i18n";

export type Side = "claude" | "openai";

export interface TrackedTask extends RunningTask {
  side: Side;
  /** null while running */
  ended_at: number | null;
}

const KEY = "uf.tasks";
/** Finished tasks are dropped after this long even if never removed. */
const KEEP_DONE_MS = 3 * 86400_000;

export function loadTasks(): TrackedTask[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveTasks(list: TrackedTask[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/** Merges a new activity snapshot into the tracked list. */
export function mergeTasks(prev: TrackedTask[], a: Activity, now: number): TrackedTask[] {
  const running = new Map<string, TrackedTask>();
  for (const [side, list] of [
    ["claude", a.claude_tasks],
    ["openai", a.codex_tasks],
  ] as const) {
    for (const t of list) running.set(side + ":" + t.id, { ...t, side, ended_at: null });
  }
  const out: TrackedTask[] = [];
  for (const t of prev) {
    const key = t.side + ":" + t.id;
    const live = running.get(key);
    if (live) {
      // Running (again): it comes back to the list as running.
      out.push({ ...live, title: live.title ?? t.title, created_at: live.created_at ?? t.created_at });
      running.delete(key);
    } else if (t.ended_at == null) {
      out.push({ ...t, ended_at: now }); // just finished
    } else if (now - t.ended_at < KEEP_DONE_MS) {
      out.push(t);
    }
  }
  out.push(...running.values());
  return out;
}

/** Running first (oldest turn on top), then finished (most recent first). */
export function sortTasks(list: TrackedTask[]): TrackedTask[] {
  return [...list].sort((a, b) => {
    if ((a.ended_at == null) !== (b.ended_at == null)) return a.ended_at == null ? -1 : 1;
    if (a.ended_at == null) return (a.started_at ?? 0) - (b.started_at ?? 0);
    return (b.ended_at ?? 0) - (a.ended_at ?? 0);
  });
}

/** "4:05", "1:02:09" */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 刚刚 / 5 分钟前 / 2 小时前 / 昨天 20:00 / 10/24 18:00 / 2025/10/24 18:00 */
export function relTime(ms: number, now: number, t: Dict): string {
  const diff = now - ms;
  const d = new Date(ms);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === n.toDateString();
  if (diff < 60_000) return t.rel_now;
  if (diff < 3600_000) return fmt(t.rel_min, { n: Math.floor(diff / 60_000) });
  if (sameDay) return fmt(t.rel_hour, { n: Math.floor(diff / 3600_000) });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return fmt(t.rel_yday, { t: hm });
  const md = `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}
