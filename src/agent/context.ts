// Builds what the model sees besides the new message. Plain code, no model call.
import type { ChatMessage } from '../llm/provider.ts';
import type { RecallResult } from '../memory/recall.ts';
import type { Turn } from '../memory/store.ts';
import { describeDay, describeRange, localDay, localTime } from '../temporal/dates.ts';

export const HISTORY_MAX_TURNS = 5;
export const HISTORY_MAX_CHARS = 12_000;
/** Characters of stored answers put into <recalled_records>, shared between the records. */
export const RECALL_MAX_CHARS = 9000;

const CUT = ' …[cut]';

/**
 * The last few turns of this session as chat messages, oldest first.
 * The total text never exceeds maxChars: each message gets an equal share and
 * is cut at the end if it is longer.
 */
export function buildSessionHistory(
  turns: Turn[],
  { maxTurns = HISTORY_MAX_TURNS, maxChars = HISTORY_MAX_CHARS } = {},
): ChatMessage[] {
  const messages: ChatMessage[] = turns.slice(-maxTurns).flatMap((turn) => [
    { role: 'user', content: turn.userMessage },
    { role: 'assistant', content: turn.assistantMessage },
  ]);
  if (messages.length === 0) return messages;
  const share = Math.floor(maxChars / messages.length);
  return messages.map((m) =>
    m.content.length <= share
      ? m
      : { ...m, content: m.content.slice(0, Math.max(0, share - CUT.length)) + CUT },
  );
}

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\s+/g, ' ');
// Stored text must not be able to close our tags.
const body = (value: string) => value.replace(/<(?=\/?\s*(recalled_records|record)\b)/gi, '&lt;');
const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, Math.max(0, max - CUT.length)) + CUT);
// Old citation numbers point at sources of the old turn, not of this one.
const dropCitations = (text: string) => text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '');
const quote = (text: string) => `"${clip(text.replace(/\s+/g, ' ').trim(), 160)}"`;

/** One line for the user about what was looked up, e.g. "Tuesday 3 November 2026, about postgres". */
export function describeLookup(result: RecallResult): string {
  const when = result.ranges.map(describeRange).join(' or ');
  const what = result.topics.length ? `about ${result.topics.join(', ')}` : '';
  return [when, what].filter(Boolean).join(', ') || 'your recent chats';
}

/** The <recalled_records> section: what memory holds for this message, or that it holds nothing. */
export function formatRecalled(result: RecallResult, timezone: string): string {
  const lines = ['<recalled_records>', `Looked for: ${describeLookup(result)}.`];

  if (result.future) {
    lines.push('That is in the future, so there is no record of it.');
  } else if (result.turns.length === 0) {
    lines.push('No records found.');
    if (result.ranges.length > 0) {
      if (result.nearest.length === 0) {
        lines.push('This user has no stored conversations on any other day either, so there is no nearest day to offer.');
      }
      else {
        lines.push('Nearest days that do have records:');
        for (const near of result.nearest) {
          lines.push(`- ${describeDay(near.day)}: asked ${near.questions.map(quote).join('; ')}`);
        }
      }
    }
  } else {
    if (result.topicMissed) {
      lines.push(
        `No record from this period mentions ${result.topics.join(' or ')}. Everything from the period is listed, so you can say what was actually discussed.`,
      );
    }
    if (result.truncated) lines.push('More records matched than fit here; these are the most relevant.');
    const share = Math.max(400, Math.floor(RECALL_MAX_CHARS / result.turns.length));
    for (const turn of result.turns) {
      const at = new Date(turn.createdAt);
      const chat = turn.sessionTitle ? ` chat="${attr(turn.sessionTitle)}"` : '';
      lines.push(
        `<record date="${describeDay(localDay(at, timezone))}" time="${localTime(at, timezone)}"${chat}>`,
        `User asked: ${body(clip(turn.userMessage, 600))}`,
        `You answered: ${body(clip(dropCitations(turn.assistantMessage), share))}`,
        '</record>',
      );
    }
  }
  lines.push('</recalled_records>');
  return lines.join('\n');
}
