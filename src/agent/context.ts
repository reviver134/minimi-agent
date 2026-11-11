// Builds what the model sees besides the new message. Plain code, no model call.
import type { ChatMessage } from '../llm/provider.ts';
import type { Turn } from '../memory/store.ts';

export const HISTORY_MAX_TURNS = 5;
export const HISTORY_MAX_CHARS = 12_000;

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
