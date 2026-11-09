export type PeriodId =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "last7"
  | "last30"
  | "custom";

export const PERIODS: PeriodId[] = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "last7",
  "last30",
  "custom",
];

/** Inclusive local-date range as YYYY-MM-DD strings. */
export interface Range {
  start: string;
  end: string;
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** weekStart: 1 = Monday, 0 = Sunday. */
export function rangeFor(id: PeriodId, weekStart: 0 | 1, custom: Range, now = new Date()): Range {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sinceWeekStart = (today.getDay() - weekStart + 7) % 7;
  const thisWeekStart = addDays(today, -sinceWeekStart);
  switch (id) {
    case "today":
      return { start: ymd(today), end: ymd(today) };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: ymd(y), end: ymd(y) };
    }
    case "thisWeek":
      return { start: ymd(thisWeekStart), end: ymd(today) };
    case "lastWeek":
      return { start: ymd(addDays(thisWeekStart, -7)), end: ymd(addDays(thisWeekStart, -1)) };
    case "thisMonth":
      return { start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), end: ymd(today) };
    case "lastMonth":
      return {
        start: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        end: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
      };
    case "last7":
      return { start: ymd(addDays(today, -6)), end: ymd(today) };
    case "last30":
      return { start: ymd(addDays(today, -29)), end: ymd(today) };
    case "custom":
      return custom.start <= custom.end ? custom : { start: custom.end, end: custom.start };
  }
}

/** Every date in the range, for the daily chart. Capped to avoid huge custom ranges. */
export function daysIn(r: Range, cap = 92): string[] {
  const out: string[] = [];
  const [y, m, d] = r.start.split("-").map(Number);
  let cur = new Date(y, m - 1, d);
  while (ymd(cur) <= r.end && out.length < cap) {
    out.push(ymd(cur));
    cur = addDays(cur, 1);
  }
  return out;
}
