// Date words in a message, resolved by code against the clock and the user's
// timezone. The model never does date arithmetic.
//
// A day is a calendar day in the user's timezone, written 'YYYY-MM-DD'.
// Questions about memory look backwards, so a date with no year, or a bare
// weekday, means the most recent one that is not in the future.

export interface DayRange {
  /** First and last local day, both included. */
  from: string;
  to: string;
}

export interface DateMention {
  /** The words that were matched, e.g. "last Tuesday". */
  text: string;
  /** What it can mean, most likely first. More than one when the phrase is ambiguous. */
  candidates: DayRange[];
  /** True when the phrase points after today, where no record can exist. */
  future?: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)';
// On its own only a full name counts: "sat", "sun" and "wed" are also ordinary words.
const WEEKDAY_FULL = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// --- calendar arithmetic on local days, done in UTC so it never depends on the machine's timezone ---

const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromMs(toMs(day) + n * DAY_MS);
const weekdayOf = (day: string) => new Date(toMs(day)).getUTCDay();
const ymd = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Rejects 31 February and the like. */
const isRealDay = (y: number, m: number, d: number) => fromMs(Date.UTC(y, m - 1, d)) === ymd(y, m, d);
const single = (day: string): DayRange => ({ from: day, to: day });

/** The calendar day it is for the user at this instant. */
export function localDay(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The local clock time (HH:MM) for the user at this instant. */
export function localTime(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** "Tuesday 3 November 2026". */
export function describeDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(new Date(toMs(day)))
    .replace(',', '');
}

export function describeRange(range: DayRange): string {
  return range.from === range.to
    ? describeDay(range.from)
    : `${describeDay(range.from)} to ${describeDay(range.to)}`;
}

/** How far the timezone is ahead of UTC at this instant, in milliseconds. */
function offsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a local day starts, in UTC. */
function startOfDay(day: string, timezone: string): Date {
  const wall = toMs(day);
  let instant = wall - offsetMs(wall, timezone);
  instant = wall - offsetMs(instant, timezone); // second pass settles days where the offset changes
  return new Date(instant);
}

/** A range of local days as UTC instants: from is included, to is not. */
export function utcBounds(range: DayRange, timezone: string): { from: string; to: string } {
  return {
    from: startOfDay(range.from, timezone).toISOString(),
    to: startOfDay(addDays(range.to, 1), timezone).toISOString(),
  };
}

// --- the phrases ---

const weekdayIndex = (word: string) => WEEKDAYS.findIndex((w) => w.startsWith(word.toLowerCase().slice(0, 3)));
const monthNumber = (word: string) => MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3))) + 1;
const count = (word: string) => NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
/** Monday of the week the day is in. */
const weekStart = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const monthEnd = (y: number, m: number) => fromMs(Date.UTC(y, m, 0));

type Rule = [RegExp, (m: RegExpExecArray, today: string) => Omit<DateMention, 'text'> | undefined];

const past = (...candidates: DayRange[]) => ({ candidates });
const future = (range: DayRange) => ({ candidates: [range], future: true });

/** Most recent day with this weekday, strictly before today. */
function previousWeekday(today: string, weekday: number): string {
  const back = (weekdayOf(today) - weekday + 7) % 7 || 7;
  return addDays(today, -back);
}

/** Day and month with no year: the most recent one that is not after today. */
function recentMonthDay(today: string, month: number, day: number): string | undefined {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year - 1, year - 2, year - 3, year - 4]) {
    if (isRealDay(y, month, day) && ymd(y, month, day) <= today) return ymd(y, month, day);
  }
  return undefined;
}

function dayMonth(m: RegExpExecArray, today: string, d: string, mon: string, y?: string) {
  const day = Number(d);
  const month = monthNumber(mon);
  // "the top 5 may change": with no year, "may" is a month only at the end of a phrase.
  if (!y && mon.toLowerCase() === 'may' && !/^\s*([?.,!;:)]|$)/.test(m.input.slice(m.index + m[0].length))) {
    return undefined;
  }
  if (y) {
    if (!isRealDay(Number(y), month, day)) return undefined;
    const exact = ymd(Number(y), month, day);
    return exact > today ? future(single(exact)) : past(single(exact));
  }
  const recent = recentMonthDay(today, month, day);
  return recent ? past(single(recent)) : undefined;
}

// Order matters: longer and more specific phrases first. Once a rule matches,
// the words it used are not offered to later rules.
const RULES: Rule[] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, today) => {
    if (!isRealDay(Number(m[1]), Number(m[2]), Number(m[3]))) return undefined;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    return day > today ? future(single(day)) : past(single(day));
  }],
  // "3 November", "3rd of Nov 2026"
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'),
    (m, today) => dayMonth(m, today, m[1]!, m[2]!, m[3])],
  // "November 3", "Nov 3rd, 2026"
  [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:am|pm|:))(?:,?\\s+(\\d{4}))?`, 'gi'),
    (m, today) => dayMonth(m, today, m[2]!, m[1]!, m[3])],
  [/\b(?:the\s+)?day before yesterday\b/gi, (_m, today) => past(single(addDays(today, -2)))],
  [/\byesterday\b/gi, (_m, today) => past(single(addDays(today, -1)))],
  [/\b(?:today|this (?:morning|afternoon|evening)|tonight|earlier today)\b/gi, (_m, today) => past(single(today))],
  [/\b(?:the\s+)?day after tomorrow\b/gi, (_m, today) => future(single(addDays(today, 2)))],
  [/\btomorrow\b/gi, (_m, today) => future(single(addDays(today, 1)))],
  // "3 days ago", "a week ago", "two weeks ago"
  [/\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+(?:ago|back)\b/gi,
    (m, today) => {
      const n = count(m[1]!);
      const unit = m[2]!.toLowerCase();
      if (unit === 'day') return past(single(addDays(today, -n)));
      if (unit === 'week') {
        // "a week ago" is loose: the same weekday that many weeks back, or anywhere in that week.
        const day = addDays(today, -7 * n);
        return past(single(day), { from: weekStart(day), to: addDays(weekStart(day), 6) });
      }
      const then = new Date(toMs(today));
      then.setUTCMonth(then.getUTCMonth() - n, 1);
      const y = then.getUTCFullYear();
      const mo = then.getUTCMonth() + 1;
      return past({ from: ymd(y, mo, 1), to: monthEnd(y, mo) });
    }],
  // "the last 3 days", "past two weeks"
  [/\b(?:the\s+)?(?:last|past|previous)\s+(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|few|couple of)\s+(day|week|month)s?\b/gi,
    (m, today) => {
      const word = m[1]!.toLowerCase();
      const n = word === 'few' ? 3 : word === 'couple of' ? 2 : count(word);
      const days = m[2]!.toLowerCase() === 'day' ? n : m[2]!.toLowerCase() === 'week' ? 7 * n : 31 * n;
      return past({ from: addDays(today, -days), to: today });
    }],
  [/\b(?:this|the current|earlier this)\s+week\b/gi, (_m, today) => past({ from: weekStart(today), to: today })],
  [/\b(?:last|the past|the previous|previous)\s+week\b/gi, (_m, today) => {
    const start = addDays(weekStart(today), -7);
    return past({ from: start, to: addDays(start, 6) });
  }],
  [/\bnext\s+week\b/gi, (_m, today) => {
    const start = addDays(weekStart(today), 7);
    return future({ from: start, to: addDays(start, 6) });
  }],
  [/\b(?:this|the current|earlier this)\s+month\b/gi, (_m, today) => past({ from: monthStart(today), to: today })],
  [/\b(?:last|the past|the previous|previous)\s+month\b/gi, (_m, today) => {
    const end = addDays(monthStart(today), -1);
    return past({ from: monthStart(end), to: end });
  }],
  [/\bthis\s+year\b/gi, (_m, today) => past({ from: `${today.slice(0, 4)}-01-01`, to: today })],
  [/\blast\s+year\b/gi, (_m, today) => {
    const y = Number(today.slice(0, 4)) - 1;
    return past({ from: `${y}-01-01`, to: `${y}-12-31` });
  }],
  // "in October", "last October", "during Oct 2026". A bare month name is not
  // matched, because "may" and "march" are also ordinary words.
  [new RegExp(`\\b(?:in|during|last|this|throughout)\\s+${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'),
    (m, today) => {
      const month = monthNumber(m[1]!);
      let year = m[2] ? Number(m[2]) : Number(today.slice(0, 4));
      if (!m[2] && ymd(year, month, 1) > today) year -= 1;
      const range = { from: ymd(year, month, 1), to: monthEnd(year, month) };
      if (range.from > today) return future(range);
      return past({ from: range.from, to: range.to > today ? today : range.to });
    }],
  [new RegExp(`\\bnext\\s+${WEEKDAY}\\b`, 'gi'), (m, today) => {
    const ahead = (weekdayIndex(m[1]!) - weekdayOf(today) + 7) % 7 || 7;
    return future(single(addDays(today, ahead)));
  }],
  // "last Tuesday": the most recent Tuesday. If that Tuesday is in this week,
  // the speaker may mean the Tuesday of last week instead, so offer both.
  [new RegExp(`\\b(?:last|this past|the previous|previous)\\s+${WEEKDAY}\\b`, 'gi'), (m, today) => {
    const recent = previousWeekday(today, weekdayIndex(m[1]!));
    return recent >= weekStart(today) ? past(single(recent), single(addDays(recent, -7))) : past(single(recent));
  }],
  // "on Monday", "Monday": the most recent one. Said on a Monday it can mean today or a week ago.
  [new RegExp(`\\b(?:(?:on|this)\\s+${WEEKDAY}|${WEEKDAY_FULL})\\b`, 'gi'), (m, today) => {
    const weekday = weekdayIndex((m[1] ?? m[2])!);
    return weekday === weekdayOf(today)
      ? past(single(today), single(addDays(today, -7)))
      : past(single(previousWeekday(today, weekday)));
  }],
];

/** Finds every date phrase in the message, in the order they appear. */
export function resolveDates(message: string, now: Date, timezone: string): DateMention[] {
  const today = localDay(now, timezone);
  const found: { index: number; mention: DateMention }[] = [];
  // Matched words are blanked out so a shorter rule cannot match inside them.
  let rest = message;
  for (const [pattern, resolve] of RULES) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(rest); m; m = pattern.exec(rest)) {
      const resolved = resolve(m, today);
      if (!resolved) continue;
      found.push({ index: m.index, mention: { text: m[0].trim(), ...resolved } });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.mention);
}
