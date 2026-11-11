// The agent's one tool. The model gives a list of queries; code runs them in
// parallel with a timeout each, numbers the sources, and hands back text in
// <search_results> tags. Everything inside those tags is data from the web.
import type { SearchProvider } from '../search/provider.ts';
import { type MetricsSink, timed } from '../telemetry/timed.ts';

export const WEB_SEARCH = {
  name: 'web_search',
  description:
    'Search the web. Give every query you need in one call: they run at the same time. ' +
    'Use one query per product, company or question. Results are numbered for citations.',
} as const;

export const SEARCH_LIMITS = {
  /** Queries run from one call; extra ones are dropped and the model is told. */
  maxQueries: 6,
  /** A search that takes longer than this is reported as failed. */
  timeoutMs: 8000,
  /** Results kept per query. */
  resultsPerQuery: 5,
  /** Characters of page text kept per result. */
  contentChars: 1500,
};

export interface Source {
  /** Citation number, unique within a turn. */
  n: number;
  url: string;
  title: string;
  publishedAt?: string;
}

/** Numbers each distinct URL once per turn, across queries and rounds. */
export class SourceRegistry {
  private readonly byUrl = new Map<string, Source>();

  /** Returns the new source, or undefined if this URL already has a number. */
  add(url: string, title: string, publishedAt?: string): Source | undefined {
    const key = canonical(url);
    if (this.byUrl.has(key)) return undefined;
    const source: Source = { n: this.byUrl.size + 1, url, title, ...(publishedAt ? { publishedAt } : {}) };
    this.byUrl.set(key, source);
    return source;
  }

  all(): Source[] {
    return [...this.byUrl.values()];
  }
}

/** The same page under small URL differences: fragment, tracking, trailing slash, www. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim();
  }
}

export interface QueryOutcome {
  query: string;
  status: 'ok' | 'failed';
  /** Why it failed, in words the model can pass on. */
  error?: string;
  /** New sources from this query, with the page text cut to the budget. */
  results: (Source & { content: string })[];
}

export interface WebSearchDeps {
  search: SearchProvider;
  metrics: MetricsSink;
  turnId: string;
  registry: SourceRegistry;
  signal?: AbortSignal;
  limits?: Partial<typeof SEARCH_LIMITS>;
}

/** Cleans what the model sent: strings only, trimmed, no repeats. */
export function readQueries(input: unknown): string[] {
  const raw = (input as { queries?: unknown } | null)?.queries;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of list) {
    const query = typeof item === 'string' ? item.trim().slice(0, 300) : '';
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    queries.push(query);
  }
  return queries;
}

/** Runs the queries at the same time. Never throws: a failed query is reported, not raised. */
export async function runWebSearch(queries: string[], deps: WebSearchDeps): Promise<QueryOutcome[]> {
  const limits = { ...SEARCH_LIMITS, ...deps.limits };
  const settled = await Promise.all(
    queries.slice(0, limits.maxQueries).map(async (query) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      deps.signal?.addEventListener('abort', stop);
      let timer: NodeJS.Timeout | undefined;
      try {
        // Each search is timed and logged on its own.
        const results = await timed(deps.metrics, deps.turnId, 'search', () =>
          Promise.race([
            deps.search.search(query, abort.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                abort.abort();
                reject(new Error(`timed out after ${limits.timeoutMs / 1000} s`));
              }, limits.timeoutMs);
            }),
          ]),
        );
        return { query, results };
      } catch (err) {
        return { query, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener('abort', stop);
      }
    }),
  );

  // Number sources in query order, so the numbering does not depend on which search was fastest.
  return settled.map((item): QueryOutcome => {
    if (!item.results) return { query: item.query, status: 'failed', error: item.error, results: [] };
    const results: QueryOutcome['results'] = [];
    for (const r of item.results.slice(0, limits.resultsPerQuery)) {
      const source = deps.registry.add(r.url, r.title, r.publishedAt);
      if (source) results.push({ ...source, content: cut(r.content, limits.contentChars) });
    }
    return { query: item.query, status: 'ok', results };
  });
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

const attr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ');

// Page text must not be able to close our tags and pose as something else.
const body = (value: string) => value.replace(/<(?=\/?\s*(search_results|query|result|note)\b)/gi, '&lt;');

/** The tool result the model reads. */
export function formatSearchResults(
  outcomes: QueryOutcome[],
  { dropped = 0, lastRound = false, searchDown = false } = {},
): string {
  const lines = ['<search_results>'];
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      lines.push(
        `<query text="${attr(outcome.query)}" status="failed">`,
        `This search failed (${body(outcome.error ?? 'unknown error')}). Nothing was checked for it: tell the user what you could not check.`,
        '</query>',
      );
      continue;
    }
    lines.push(`<query text="${attr(outcome.query)}" status="ok">`);
    if (outcome.results.length === 0) lines.push('No new results.');
    for (const r of outcome.results) {
      const published = r.publishedAt ? ` published="${attr(r.publishedAt)}"` : '';
      lines.push(`<result n="${r.n}" url="${attr(r.url)}" title="${attr(r.title)}"${published}>`, body(r.content), '</result>');
    }
    lines.push('</query>');
  }
  lines.push('</search_results>');
  if (dropped > 0) {
    lines.push(`<note>${dropped} more ${dropped === 1 ? 'query was' : 'queries were'} not run: one call takes at most ${SEARCH_LIMITS.maxQueries}.</note>`);
  }
  if (searchDown) {
    lines.push('<note>Web search is not working right now, so do not search again. Answer from what you know and from the records, and tell the user plainly that you could not check the web.</note>');
  } else if (lastRound) {
    lines.push('<note>This was your last search for this message. Answer now with what you have, and say what you could not check.</note>');
  }
  return lines.join('\n');
}
