// Query understanding: one small call to the fast model that says whether a
// message needs memory, whether it needs the web, and what subject it is about.
// Code finds the dates first; the model only picks which of them matter. If
// the call fails or is slow, code falls back to rules, so a turn never depends on it.
import { z } from 'zod';
import { type ModelProvider, collectText } from '../llm/provider.ts';
import { logError } from '../telemetry/log.ts';
import { type DateMention, type DayRange, addDays, describeDay, localDay } from '../temporal/dates.ts';

export interface Understanding {
  needsRecall: boolean;
  needsSearch: boolean;
  topics: string[];
  /** Local-day ranges the earlier conversation may be in. Empty means no date was given. */
  ranges: DayRange[];
  /** True when the topics are just the words of the message, not a subject someone picked out. */
  softTopics?: boolean;
  /** False when code decided, or the model call failed and rules were used instead. */
  fromModel: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const understandingSchema = z.object({
  needs_recall: z.boolean(),
  needs_search: z.boolean(),
  topics: z.array(z.string()),
  when: z.array(z.number().int()),
  date_from: z.string().nullable(),
  date_to: z.string().nullable(),
});

// Words that suggest the message leans on an earlier conversation. Messages
// with none of these, and no date, skip the call entirely and cost no time.
const MEMORY_CUE =
  /\b(did (i|we)|have (i|we)|had (i|we)|(i|we) (asked|talked|discussed|spoke|chatted|compared|shortlisted|looked at|decided|agreed)|you (said|told|recommended|suggested|shortlisted|mentioned|answered|gave|listed|picked|advised)|ask(ed)? you|last time|earlier|previously|the other day|remember|recall|still (correct|right|true|valid|accurate|the case|up to date)|your (answer|recommendation|shortlist|suggestion|advice|list)|our (chat|conversation|discussion)|will i ask)\b/i;

export function hasMemoryCue(message: string): boolean {
  return MEMORY_CUE.test(message);
}

const isToday = (m: DateMention, today: string) =>
  m.candidates.length === 1 && m.candidates[0]!.from === today && m.candidates[0]!.to === today;

/** What code alone can say: used when the model call fails. */
export function understandByRules(message: string, mentions: DateMention[], today: string): Understanding {
  // "Is it still correct today?" is not about a conversation held today.
  const others = mentions.filter((m) => !isToday(m, today));
  const used = others.length > 0 ? others : /\b(did|have) (i|we)\b/i.test(message) ? mentions : [];
  const ranges = used.flatMap((m) => m.candidates);
  return {
    needsRecall: true,
    needsSearch: true,
    // With a date, the date is enough. Without one, the words of the message are all there is to go on.
    topics: ranges.length > 0 ? [] : [message.replace(/\d+/g, ' ')],
    softTopics: true,
    ranges,
    fromModel: false,
  };
}

// "What did I ask you on 3 November?", "What did we talk about last Tuesday about Postgres?"
const PLAIN_RECALL =
  /^\s*(?:so\s+|and\s+|ok(?:ay)?,?\s+)?(?:what|which\s+\w+|what\s+\w+)\b[^?]*\b(?:did|have|had)\s+(?:i|we)\b[^?]*\b(?:ask(?:ed)?|talk(?:ed)?|discuss(?:ed)?|chat(?:ted)?|say|said|cover(?:ed)?|look(?:ed)? at)\b[^?]*\??\s*$/i;
// Anything that asks about the present needs the model's judgement, and maybe the web.
const ABOUT_NOW = /\b(still|now|current(ly)?|latest|today|changed?|since|correct|right|true|update[ds]?|new(er)?|cheapest|best|should)\b/i;

/**
 * A plain question about what was said on a date needs no model call to
 * understand: recall by the date, plus the subject after "about" if there is one.
 * Returns undefined for anything less simple.
 */
export function understandPlainRecall(message: string, mentions: DateMention[]): Understanding | undefined {
  if (mentions.length !== 1 || !PLAIN_RECALL.test(message) || ABOUT_NOW.test(message)) return undefined;
  const mention = mentions[0]!;
  const rest = message.replace(mention.text, ' ');
  const about = /\babout\s+([^?.!,]+)/i.exec(rest)?.[1]?.trim();
  return {
    needsRecall: true,
    needsSearch: false,
    topics: about ? [about] : [],
    ranges: mention.candidates,
    fromModel: false,
  };
}

/**
 * A message with a memory phrase and a date ("Last Tuesday I asked you about
 * Postgres hosting. Has any pricing changed since then?") is also settled by
 * code: recall by the date, narrow by the words of the message, and allow the
 * web if it asks about the present. What is left for the model call are
 * memory questions with no date, and dated messages with no memory phrase.
 */
export function understandDatedMemory(message: string, mentions: DateMention[], today: string): Understanding | undefined {
  if (!hasMemoryCue(message)) return undefined;
  const dated = mentions.filter((m) => !isToday(m, today));
  if (dated.length === 0) return undefined;
  let words = message;
  for (const m of mentions) words = words.replace(m.text, ' ');
  return {
    needsRecall: true,
    needsSearch: ABOUT_NOW.test(message),
    topics: [words.replace(/\d+/g, ' ')],
    softTopics: true,
    ranges: dated.flatMap((m) => m.candidates),
    fromModel: false,
  };
}

function calendar(today: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(today, -i);
    lines.push(`${day} ${describeDay(day).split(' ')[0]}${i === 0 ? ' (today)' : i === 1 ? ' (yesterday)' : ''}`);
  }
  return lines.join('\n');
}

export interface UnderstandInput {
  message: string;
  now: Date;
  timezone: string;
  mentions: DateMention[];
  /** Give up and use rules after this long. Default 6 s. */
  timeoutMs?: number;
}

export async function understandQuery(
  model: ModelProvider,
  prompt: string,
  input: UnderstandInput,
): Promise<Understanding> {
  const today = localDay(input.now, input.timezone);
  const found = input.mentions.length
    ? input.mentions
        .map((m, i) => `${i + 1}. "${m.text}" = ${m.candidates.map((c) => (c.from === c.to ? c.from : `${c.from} to ${c.to}`)).join(' or ')}${m.future ? ' (in the future)' : ''}`)
        .join('\n')
    : 'none';
  const content = [
    `Today: ${describeDay(today)} (${today})`,
    `Recent days:\n${calendar(today)}`,
    `Date phrases found by code:\n${found}`,
    `Message:\n"""\n${input.message.slice(0, 2000)}\n"""`,
  ].join('\n\n');

  try {
    const text = await collectText(
      model.stream({
        model: 'fast',
        label: 'understand',
        system: prompt,
        messages: [{ role: 'user', content }],
        json: understandingSchema,
        signal: AbortSignal.timeout(input.timeoutMs ?? 6000),
      }),
    );
    const parsed = understandingSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()));

    // Dates: the ones code resolved, as chosen by the model. The model's own
    // dates are used only when code found nothing, and only if they are real past days.
    let ranges = parsed.when
      .map((n) => input.mentions[n - 1])
      .filter((m): m is DateMention => m !== undefined)
      .flatMap((m) => m.candidates);
    if (input.mentions.length === 0 && parsed.date_from && ISO_DAY.test(parsed.date_from)) {
      const to = parsed.date_to && ISO_DAY.test(parsed.date_to) ? parsed.date_to : parsed.date_from;
      const valid = !Number.isNaN(Date.parse(parsed.date_from)) && !Number.isNaN(Date.parse(to));
      if (valid && parsed.date_from <= to && parsed.date_from <= today) ranges = [{ from: parsed.date_from, to }];
    }
    return {
      needsRecall: parsed.needs_recall,
      needsSearch: parsed.needs_search,
      topics: parsed.topics,
      ranges,
      fromModel: true,
    };
  } catch (err) {
    logError('query understanding failed, using rules', err);
    return understandByRules(input.message, input.mentions, today);
  }
}
