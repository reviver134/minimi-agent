// Answer records: the checkable content of a stored answer. They are derived
// from the raw turn by the write-back call and can be rebuilt from it.
import type { Source } from '../agent/webSearch.ts';

export interface Entity {
  /** The thing a claim is about, e.g. "Neon". */
  name: string;
  /** A search query that finds its current state, e.g. "Neon Launch plan price". No dates in it. */
  query: string;
}

export interface Claim {
  entity: string;
  /** What is claimed about it, e.g. "Launch plan price". */
  attribute: string;
  /** Exactly as the answer stated it, e.g. "$19/month". */
  value: string;
  /** The user's local day the answer was given, YYYY-MM-DD. */
  asOf: string;
  /** The citation number of the source, if the answer cited one. */
  sourceN: number | null;
}

export interface AnswerRecord {
  turnId: string;
  topic: string;
  entities: Entity[];
  claims: Claim[];
  createdAt: string;
}

export const RECORD_LIMITS = { entities: 8, claims: 24 };

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Checks what the model extracted against the answer it came from. A claim is
 * kept only if its value appears in the answer character for character, so a
 * stored number can never differ from the one the user was shown.
 */
export function buildRecord(
  raw: unknown,
  context: { answer: string; sources: Source[]; asOf: string },
): Pick<AnswerRecord, 'topic' | 'entities' | 'claims'> | undefined {
  const input = (raw ?? {}) as { topic?: unknown; entities?: unknown; claims?: unknown };
  const topic = text(input.topic, 80);
  const sourceNumbers = new Set(context.sources.map((s) => s.n));

  const entities: Entity[] = [];
  const addEntity = (name: string, query: string) => {
    if (!name || entities.some((e) => e.name.toLowerCase() === name.toLowerCase())) return;
    if (entities.length < RECORD_LIMITS.entities) entities.push({ name, query: query || `${name} ${topic}`.trim() });
  };
  for (const e of Array.isArray(input.entities) ? input.entities : []) {
    addEntity(text((e as any)?.name, 80), text((e as any)?.query, 160));
  }

  const claims: Claim[] = [];
  for (const c of Array.isArray(input.claims) ? input.claims : []) {
    const entity = text((c as any)?.entity, 80);
    const attribute = text((c as any)?.attribute, 120);
    const value = typeof (c as any)?.value === 'string' ? (c as any).value.trim() : '';
    if (!entity || !value || value.length > 200 || !context.answer.includes(value)) continue;
    if (claims.length >= RECORD_LIMITS.claims) break;
    const n = (c as any)?.source_n;
    addEntity(entity, '');
    claims.push({
      entity,
      attribute,
      value,
      asOf: context.asOf,
      sourceN: typeof n === 'number' && sourceNumbers.has(n) ? n : null,
    });
  }

  if (!topic || (entities.length === 0 && claims.length === 0)) return undefined;
  return { topic, entities, claims };
}

export const PROFILE_LIMITS = { items: 8, chars: 140 };

/** The profile is a short list of plain statements about the user. Anything else is dropped. */
export function cleanProfile(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: string[] = [];
  for (const item of raw) {
    const line = text(item, PROFILE_LIMITS.chars);
    if (line && !items.some((i) => i.toLowerCase() === line.toLowerCase())) items.push(line);
    if (items.length >= PROFILE_LIMITS.items) break;
  }
  return items;
}
