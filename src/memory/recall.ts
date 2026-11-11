// Recall: which stored turns a message is about. Plain queries by user, date
// range and topic keywords. It never guesses: when nothing matches it says so
// and names the nearest days that do have records.
import { type DayRange, localDay, utcBounds } from '../temporal/dates.ts';
import type { RecalledTurn, Store } from './store.ts';

export interface RecallQuery {
  userId: string;
  timezone: string;
  /** Local-day ranges to look in; several when the date phrase was ambiguous. Empty means any date. */
  ranges: DayRange[];
  /** Subject keywords. Empty means any topic. */
  topics: string[];
  /** The topics are only the words of the message: use them to narrow, but do not report a miss. */
  softTopics?: boolean;
  /** Today's local day, to tell future ranges apart. */
  today: string;
  /** Most turns to return. */
  limit?: number;
}

export interface NearestDay {
  day: string;
  questions: string[];
}

export interface RecallResult {
  ranges: DayRange[];
  topics: string[];
  /** Matching turns, oldest first. */
  turns: RecalledTurn[];
  /** True when topics were given but no turn in the date range mentions them; turns then holds the whole range. */
  topicMissed: boolean;
  /** True when every range asked for lies after today. */
  future: boolean;
  /** When nothing was found for the dates: the closest earlier and later days that have records. */
  nearest: NearestDay[];
  /** More turns matched than were returned. */
  truncated: boolean;
}

const STOPWORDS = new Set(
  ('the a an and or but of for to in on at by with from about into over is are was were be been do does did have has had ' +
    'i you we me my your our it its this that these those what which who when where why how any some all one ' +
    'ask asked asking tell told said say talk talked discuss discussed chat conversation question answer answers ' +
    'today yesterday week month year last past since still now then ago earlier before again please can could would should ' +
    'price prices pricing cost costs change changed changes correct right thing things something anything ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday tomorrow tonight morning').split(' '),
);

/** Lower-case subject words: no stopwords, no short words. */
export function cleanTopics(topics: string[]): string[] {
  const words = new Set<string>();
  for (const topic of topics) {
    for (const raw of topic.toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u)) {
      const word = raw.replace(/^[.-]+|[.-]+$/g, '');
      if (word.length >= 3 && !STOPWORDS.has(word) && !STOPWORDS.has(raw)) words.add(word);
    }
  }
  return [...words].slice(0, 6);
}

/** "crms" also finds "CRM": a trailing s is dropped before matching. */
export const stem = (keyword: string) => (keyword.length > 3 && keyword.endsWith('s') ? keyword.slice(0, -1) : keyword);

// The session title is not matched: it would pull in every turn of a chat, on any subject.
const mentions = (turn: RecalledTurn, keyword: string) =>
  `${turn.userMessage}\n${turn.assistantMessage}`.toLowerCase().includes(stem(keyword));

const hits = (turn: RecalledTurn, keywords: string[]) => keywords.filter((k) => mentions(turn, k)).length;

export function recall(store: Store, query: RecallQuery): RecallResult {
  const limit = query.limit ?? 12;
  const topics = cleanTopics(query.topics);
  const ranges = query.ranges.filter((r) => r.from <= query.today);
  const base = { ranges: query.ranges, topics, topicMissed: false, future: false, nearest: [], truncated: false };

  if (query.ranges.length > 0 && ranges.length === 0) return { ...base, turns: [], future: true };

  // No date: by topic alone, or failing that the most recent turns.
  if (ranges.length === 0) {
    if (topics.length === 0) return { ...base, turns: store.latestTurns(query.userId, 5).reverse() };
    const found = store
      .turnsMentioning(query.userId, topics.map(stem))
      .map((turn) => ({ turn, score: hits(turn, topics) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score || b.turn.createdAt.localeCompare(a.turn.createdAt));
    const best = found.slice(0, Math.min(limit, 6)).map((f) => f.turn);
    best.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...base, turns: best, truncated: found.length > best.length };
  }

  // By date: every candidate range, without repeats, in time order.
  const byId = new Map<string, RecalledTurn>();
  for (const range of ranges) {
    const bounds = utcBounds({ from: range.from, to: range.to > query.today ? query.today : range.to }, query.timezone);
    for (const turn of store.turnsBetween(query.userId, bounds.from, bounds.to)) byId.set(turn.turnId, turn);
  }
  let turns = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (turns.length === 0) {
    return { ...base, turns: [], nearest: nearestDays(store, query, ranges) };
  }

  let topicMissed = false;
  if (topics.length > 0) {
    const onTopic = turns.filter((turn) => hits(turn, topics) > 0);
    if (onTopic.length > 0) turns = onTopic;
    else topicMissed = !query.softTopics;
  }
  const truncated = turns.length > limit;
  return { ...base, turns: truncated ? turns.slice(-limit) : turns, topicMissed, truncated };
}

/** The closest day before and after the ranges that has records, with what was asked then. */
function nearestDays(store: Store, query: RecallQuery, ranges: DayRange[]): NearestDay[] {
  const from = ranges.map((r) => r.from).sort()[0]!;
  const to = ranges.map((r) => r.to).sort().at(-1)!;
  const bounds = utcBounds({ from, to }, query.timezone);
  const times = store.nearestTurnTimes(query.userId, bounds.from, bounds.to);
  const days: NearestDay[] = [];
  for (const at of [times.before, times.after]) {
    if (!at) continue;
    const day = localDay(new Date(at), query.timezone);
    const dayBounds = utcBounds({ from: day, to: day }, query.timezone);
    const questions = store
      .turnsBetween(query.userId, dayBounds.from, dayBounds.to, 5)
      .map((t) => t.userMessage);
    days.push({ day, questions });
  }
  return days;
}

