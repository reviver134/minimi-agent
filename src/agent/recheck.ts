// Re-check: the user asks whether an earlier answer still holds. Code already
// knows what to look up, from the answer records of the recalled turns, so it
// searches once per stored entity before the model is called. The model then
// writes the then-versus-now answer from the stored claims and today's results,
// without a round trip to decide what to search for.
import type { AnswerRecord, Claim } from '../memory/records.ts';
import type { RecalledTurn } from '../memory/store.ts';
import { describeDay, localDay } from '../temporal/dates.ts';
import {
  type QueryOutcome,
  SEARCH_LIMITS,
  type WebSearchDeps,
  formatSearchResults,
  runWebSearch,
} from './webSearch.ts';

export interface RecheckItem {
  entity: string;
  query: string;
  /** The stored claims about this entity. */
  claims: Claim[];
}

export interface RecheckPlan {
  items: RecheckItem[];
  /** Entities left out because one round takes at most maxQueries. */
  skipped: string[];
}

/** One query per stored entity, across the recalled turns, in the order they were stored. */
export function planRecheck(records: AnswerRecord[], year: string, maxQueries = SEARCH_LIMITS.maxQueries): RecheckPlan {
  const items: RecheckItem[] = [];
  const skipped: string[] = [];
  for (const record of records) {
    for (const entity of record.entities) {
      if (items.some((i) => i.entity.toLowerCase() === entity.name.toLowerCase())) continue;
      if (items.length >= maxQueries) {
        skipped.push(entity.name);
        continue;
      }
      items.push({
        entity: entity.name,
        // The year steers the search towards current pages.
        query: `${entity.query} ${year}`,
        claims: record.claims.filter((c) => c.entity.toLowerCase() === entity.name.toLowerCase()),
      });
    }
  }
  return { items, skipped };
}

const MONEY = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?/;
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * Whether today's results for an entity still show a stored value. For a
 * price the amount is what is looked for ("$19"), otherwise the whole value.
 * It is a hint for the model, not a verdict: "no" can also mean the page
 * words it differently.
 */
export function stillStated(claim: Claim, outcome: QueryOutcome | undefined): 'yes' | 'no' | 'not checked' {
  if (!outcome || outcome.status === 'failed') return 'not checked';
  const page = squash(outcome.results.map((r) => r.content).join(' '));
  const needle = squash(MONEY.exec(claim.value)?.[0] ?? claim.value);
  // "$19" must not match inside "$199".
  const index = page.indexOf(needle);
  if (index === -1) return 'no';
  const next = page[index + needle.length] ?? '';
  return /[\d]/.test(next) && /\d$/.test(needle) ? 'no' : 'yes';
}

const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ');

export interface Recheck {
  queries: string[];
  outcomes: QueryOutcome[];
  /** The <recheck> section for the system prompt. */
  block: string;
}

export async function runRecheck(
  plan: RecheckPlan,
  turns: RecalledTurn[],
  timezone: string,
  deps: WebSearchDeps,
): Promise<Recheck> {
  const queries = plan.items.map((i) => i.query);
  // Each query is about one known item, so three results are enough and keep the prompt small.
  const outcomes = await runWebSearch(queries, { ...deps, limits: { resultsPerQuery: 3, ...deps.limits } });
  const days = [...new Set(turns.map((t) => describeDay(localDay(new Date(t.createdAt), timezone))))];

  const lines = [
    '<recheck>',
    `The user is asking whether what you said on ${days.join(' and ')} still holds. The app has already searched once for each item you named then; the results are below. First name every question in <recalled_records>, including any that has no row in the table. Then go through every item in the table: give the value then with its date, the value now with the [n] of the result it comes from, and say plainly whether it changed, did not change, or could not be checked. Only today's results get a citation: write the value then as plain text with nothing in brackets after it. Do not search again for an item that already has results.`,
    '',
    '| Item | What | Value then | Search | Value then still appears in today\'s results |',
    '|---|---|---|---|---|',
  ];
  plan.items.forEach((item, i) => {
    const outcome = outcomes[i];
    const state = !outcome || outcome.status === 'failed' ? 'failed' : 'ok';
    if (item.claims.length === 0) {
      lines.push(`| ${cell(item.entity)} | (no stored value) | | ${state} | |`);
    }
    for (const claim of item.claims) {
      lines.push(
        `| ${cell(item.entity)} | ${cell(claim.attribute)} | ${cell(claim.value)} | ${state} | ${stillStated(claim, outcome)} |`,
      );
    }
  });
  lines.push(
    '',
    '"yes" means the stored value was found in today\'s results, which suggests no change. "no" means it was not found: read the results to see whether the value changed or the page only words it differently.',
  );
  if (plan.skipped.length > 0) {
    lines.push(`Not searched yet (one round takes at most ${SEARCH_LIMITS.maxQueries}): ${plan.skipped.join(', ')}. Search for these yourself if the user needs them.`);
  }
  lines.push('', formatSearchResults(outcomes), '</recheck>');
  return { queries, outcomes, block: lines.join('\n') };
}
