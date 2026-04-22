/**
 * Tiny "X ago" / "in X" formatter for CRM list rows + activity timelines.
 * Doesn't pull in date-fns transitively; we only need ~6 buckets.
 */
export function formatRelativeDate(input: string | number | Date | null | undefined): string {
  if (!input) {return "";}
  const ts = typeof input === "string" ? Date.parse(input) : input instanceof Date ? input.getTime() : input;
  if (!Number.isFinite(ts)) {return "";}
  const diffMs = Date.now() - (ts);
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  function fmt(value: number, unit: string): string {
    const rounded = Math.round(value);
    const noun = rounded === 1 ? unit : `${unit}s`;
    return future ? `in ${rounded}${unit.charAt(0)}` : `${rounded}${unit.charAt(0)} ago`.replace(noun, unit.charAt(0));
  }
  void fmt; // (we use the simpler shorthand below)

  const short = (n: number, suffix: string) => (future ? `in ${n}${suffix}` : `${n}${suffix} ago`);

  if (abs < minute) {return future ? "soon" : "just now";}
  if (abs < hour) {return short(Math.round(abs / minute), "m");}
  if (abs < day) {return short(Math.round(abs / hour), "h");}
  if (abs < week) {return short(Math.round(abs / day), "d");}
  if (abs < month) {return short(Math.round(abs / week), "w");}
  if (abs < year) {return short(Math.round(abs / month), "mo");}
  return short(Math.round(abs / year), "y");
}

/**
 * Absolute formatted date for tooltips: "Apr 16, 2026 · 5:38 PM".
 */
export function formatAbsoluteDate(input: string | number | Date | null | undefined): string {
  if (!input) {return "";}
  const date = typeof input === "string" ? new Date(input) : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {return "";}
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Date-only label suitable for sticky day headers in calendar/inbox views.
 */
export function formatDayLabel(input: string | number | Date | null | undefined): string {
  if (!input) {return "";}
  const date = typeof input === "string" ? new Date(input) : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {return "";}
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) {return "Today";}
  if (sameDay(date, yesterday)) {return "Yesterday";}
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  }).format(date);
}
