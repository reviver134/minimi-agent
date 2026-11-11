// Write-back: what is derived from a turn after the reply has streamed. One
// call to the fast model returns up to four things: the chat title, the answer
// record, the updated user profile and the updated session summary. It runs
// after the last token and never fails a turn: each part is checked by code and
// simply left out if it is missing or wrong.
import { z } from 'zod';
import type { Source } from '../agent/webSearch.ts';
import { type ModelProvider, collectText } from '../llm/provider.ts';
import { logError } from '../telemetry/log.ts';
import { type AnswerRecord, buildRecord, cleanProfile } from './records.ts';
import type { Turn } from './store.ts';

export const writebackSchema = z.object({
  title: z.string().nullable(),
  record: z
    .object({
      topic: z.string(),
      entities: z.array(z.object({ name: z.string(), query: z.string() })),
      claims: z.array(
        z.object({ entity: z.string(), attribute: z.string(), value: z.string(), source_n: z.number().nullable() }),
      ),
    })
    .nullable(),
  profile: z.array(z.string()).nullable(),
  summary: z.string().nullable(),
});

export interface WritebackInput {
  userMessage: string;
  answer: string;
  sources: Source[];
  /** The user's local day of the turn, YYYY-MM-DD. */
  asOf: string;
  /** True on a chat's first turn: it needs a title. */
  firstTurn: boolean;
  profile: string[];
  /** A turn that has just dropped out of the history window, with the summary so far. */
  aging?: { turn: Turn; summary: string | null };
}

export interface WritebackResult {
  title?: string;
  record?: Pick<AnswerRecord, 'topic' | 'entities' | 'claims'>;
  profile?: string[];
  summary?: string;
}

const MAX_TITLE_CHARS = 60;

function tidyTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const title = line.replace(/^["'“‘\s]+|["'”’.\s]+$/g, '');
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

// A message that may say something lasting about the user or how they want answers.
const PROFILE_CUE =
  /\b(my name is|call me|i am|i'm|i work|i live|i use|i prefer|i like|i want|i need|i don't|i do not|from now on|always|never|keep (your )?(answers|replies|it)|(short|shorter|brief|long|longer|detailed|concise) (answers|replies|responses)|use tables|no tables|in future|going forward|remember that|please (don't|do not|stop|use|keep|give))\b/i;

/** Which parts this turn needs. No part needed means no call at all. */
export function writebackParts(input: WritebackInput) {
  return {
    title: input.firstTurn,
    // An answer built on sources, or a long one, may hold facts worth checking later.
    record: input.sources.length > 0 || input.answer.length >= 400,
    profile: PROFILE_CUE.test(input.userMessage),
    summary: input.aging !== undefined,
  };
}

/** Never throws. Returns only the parts that were wanted and came back valid; a first turn always gets a title. */
export async function runWriteback(
  model: ModelProvider,
  prompt: string,
  input: WritebackInput,
): Promise<WritebackResult> {
  const parts = writebackParts(input);
  const result: WritebackResult = {};
  if (parts.title || parts.record || parts.profile || parts.summary) {
    const wanted = Object.entries(parts).filter(([, on]) => on).map(([name]) => name);
    const content = [
      `Parts wanted: ${wanted.join(', ')}. Set the others to null.`,
      `User's message:\n"""\n${input.userMessage.slice(0, 2000)}\n"""`,
      ...(parts.record
        ? [
            `Assistant's answer:\n"""\n${input.answer.slice(0, 6000)}\n"""`,
            `Sources cited by number: ${input.sources.map((s) => `[${s.n}] ${s.title}`).join('; ') || 'none'}`,
          ]
        : []),
      ...(parts.profile ? [`Current profile: ${JSON.stringify(input.profile)}`] : []),
      ...(input.aging
        ? [
            `Summary so far: ${input.aging.summary ?? '(none yet)'}`,
            `Turn to fold in:\nUser: ${input.aging.turn.userMessage.slice(0, 1500)}\nAssistant: ${input.aging.turn.assistantMessage.slice(0, 2500)}`,
          ]
        : []),
    ].join('\n\n');

    try {
      const text = await collectText(
        model.stream({
          model: 'fast',
          label: 'writeback',
          system: prompt,
          messages: [{ role: 'user', content }],
          json: writebackSchema,
          signal: AbortSignal.timeout(20_000),
        }),
      );
      const parsed = writebackSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()));
      if (parts.title && parsed.title) result.title = tidyTitle(parsed.title) || undefined;
      if (parts.record && parsed.record) {
        result.record = buildRecord(parsed.record, { answer: input.answer, sources: input.sources, asOf: input.asOf });
      }
      if (parts.profile && parsed.profile) result.profile = cleanProfile(parsed.profile);
      if (parts.summary && parsed.summary?.trim()) result.summary = parsed.summary.trim().slice(0, 800);
    } catch (err) {
      // The turn is already stored and the user already has the answer: log and carry on.
      logError('write-back failed', err);
    }
  }
  if (parts.title && !result.title) result.title = tidyTitle(input.userMessage);
  return result;
}
