// The agent loop: one model, one tool. The model may search for at most
// maxRounds rounds; after that it must answer with what it has.
import type { AgentMessage, ModelProvider, ToolCall, Usage } from '../llm/provider.ts';
import type { SearchProvider } from '../search/provider.ts';
import type { MetricsSink } from '../telemetry/timed.ts';
import {
  SEARCH_LIMITS,
  type Source,
  type SourceRegistry,
  WEB_SEARCH,
  formatSearchResults,
  readQueries,
  runWebSearch,
} from './webSearch.ts';

export const MAX_SEARCH_ROUNDS = 3;

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'search'; round: number; queries: string[] }
  | { type: 'search_done'; round: number; sources: Source[]; failed: string[] };

export interface AgentDeps {
  model: ModelProvider;
  search: SearchProvider;
  metrics: MetricsSink;
  turnId: string;
  system: string;
  /** Session history, then the new user message. */
  messages: AgentMessage[];
  /** Collects the numbered sources of this turn. */
  registry: SourceRegistry;
  signal?: AbortSignal;
  maxRounds?: number;
  searchLimits?: Partial<typeof SEARCH_LIMITS>;
}

export async function* runAgent(deps: AgentDeps): AsyncGenerator<AgentEvent> {
  const maxRounds = deps.maxRounds ?? MAX_SEARCH_ROUNDS;
  const maxQueries = deps.searchLimits?.maxQueries ?? SEARCH_LIMITS.maxQueries;
  const messages = [...deps.messages];

  let searchDown = false;
  for (let round = 0; ; round++) {
    const mayCall = round < maxRounds && !searchDown;
    const result = deps.model.stream({
      model: 'main',
      system: deps.system,
      messages,
      tools: [WEB_SEARCH],
      toolChoice: mayCall ? 'auto' : 'none',
      signal: deps.signal,
    });

    // One model step, timed by hand because it yields while it runs.
    const calls: ToolCall[] = [];
    const startedMs = Date.now();
    const t0 = performance.now();
    let status: 'ok' | 'error' = 'ok';
    let usage: Usage | undefined;
    try {
      for await (const part of result.parts) {
        if (part.type === 'text') yield { type: 'text', text: part.text };
        else if (part.name === WEB_SEARCH.name) calls.push(part);
      }
      usage = await result.usage;
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      deps.metrics.record({
        turnId: deps.turnId,
        step: 'model_round',
        startedMs,
        durationMs: performance.now() - t0,
        status,
        tokensIn: usage?.tokensIn,
        tokensOut: usage?.tokensOut,
      });
    }

    if (calls.length === 0 || !mayCall || deps.signal?.aborted) return;

    const asked = calls.map((call) => readQueries(call.input));
    yield { type: 'search', round, queries: asked.flatMap((q) => q.slice(0, maxQueries)) };

    const outcomes = await Promise.all(
      asked.map((queries) =>
        runWebSearch(queries, {
          search: deps.search,
          metrics: deps.metrics,
          turnId: deps.turnId,
          registry: deps.registry,
          signal: deps.signal,
          limits: deps.searchLimits,
        }),
      ),
    );
    const flat = outcomes.flat();
    // If every search of the round failed, the provider is down: searching again would only cost time.
    searchDown = flat.length > 0 && flat.every((o) => o.status === 'failed');
    const lastRound = round + 1 >= maxRounds || searchDown;
    yield {
      type: 'search_done',
      round,
      sources: flat.flatMap((o) => o.results.map(({ content: _content, ...source }) => source)),
      failed: flat.filter((o) => o.status === 'failed').map((o) => o.query),
    };

    messages.push(await result.step, {
      role: 'tool',
      results: calls.map((call, i) => ({
        id: call.id,
        name: call.name,
        output: formatSearchResults(outcomes[i]!, {
          dropped: Math.max(0, asked[i]!.length - maxQueries),
          lastRound,
          searchDown,
        }),
      })),
    });
  }
}
