// HTTP routes: users, sessions, the streaming chat endpoint and the static chat page.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HISTORY_MAX_TURNS, buildSessionHistory, describeLookup, formatRecalled } from '../agent/context.ts';
import { MAX_SEARCH_ROUNDS, runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from '../agent/prompt.ts';
import { planRecheck, runRecheck } from '../agent/recheck.ts';
import {
  hasMemoryCue,
  understandDatedMemory,
  understandPlainRecall,
  understandQuery,
} from '../agent/understand.ts';
import { type Source, SourceRegistry } from '../agent/webSearch.ts';
import type { ModelProvider } from '../llm/provider.ts';
import { recall } from '../memory/recall.ts';
import type { AnswerRecord } from '../memory/records.ts';
import { type Session, type Store, normaliseName } from '../memory/store.ts';
import { runWriteback } from '../memory/writeback.ts';
import type { SearchProvider } from '../search/provider.ts';
import { logError, turnLine, userMessageFor } from '../telemetry/log.ts';
import { timed } from '../telemetry/timed.ts';
import { type Clock, isTimezone } from '../temporal/clock.ts';
import { localDay, resolveDates } from '../temporal/dates.ts';

export interface AppDeps {
  model: ModelProvider;
  search: SearchProvider;
  /** Holds users, sessions and turns, and records the metrics of every turn. */
  store: Store;
  clock: Clock;
  /** The fixed part of the system prompt (prompts/system.md). */
  systemPrompt: string;
  /** The prompt of the write-back call (prompts/writeback.md). */
  writebackPrompt: string;
  /** The prompt of the query-understanding call (prompts/understand.md). */
  understandPrompt: string;
  /** Where the one-line summary of each finished turn goes. Left out in tests. */
  log?: (line: string) => void;
  /** Folder holding the static chat page, relative to the working directory. */
  webRoot?: string;
}

// The chat page's two libraries, served from node_modules so the page needs no build step and no CDN.
const VENDOR: Record<string, string> = {
  'marked.js': 'node_modules/marked/lib/marked.umd.js',
  'purify.js': 'node_modules/dompurify/dist/purify.min.js',
};

const MAX_MESSAGE_CHARS = 8000;
const MAX_NAME_CHARS = 60;

const sourceJson = (s: Source) => ({ n: s.n, url: s.url, title: s.title, published_at: s.publishedAt ?? null });

const sessionJson = (s: Session) => ({
  session_id: s.sessionId,
  title: s.title,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
});

export function createApp(deps: AppDeps): Hono {
  const { store } = deps;
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Anything a route did not expect: log it, and tell the page in words it can show.
  app.onError((err, c) => {
    logError(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: 'Something went wrong on the server. Please try again.' }, 500);
  });

  // A name is the whole identity: the same name always maps to the same user.
  app.post('/api/users', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === 'string' ? normaliseName(body.name) : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (name.length > MAX_NAME_CHARS) {
      return c.json({ error: `name is longer than ${MAX_NAME_CHARS} characters` }, 400);
    }
    const timezone = isTimezone(body.timezone) ? body.timezone : 'UTC';
    const user = store.getOrCreateUser(name, timezone, deps.clock.now());
    return c.json({ user_id: user.userId, user_name: user.userName, timezone: user.timezone });
  });

  app.get('/api/sessions', (c) => {
    const user = store.getUser(c.req.query('user_id') ?? '');
    if (!user) return c.json({ error: 'unknown user' }, 404);
    return c.json({ sessions: store.listSessions(user.userId).map(sessionJson) });
  });

  app.get('/api/sessions/:id/turns', (c) => {
    const user = store.getUser(c.req.query('user_id') ?? '');
    if (!user) return c.json({ error: 'unknown user' }, 404);
    const session = store.getSession(user.userId, c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return c.json({
      session: sessionJson(session),
      turns: store.listTurns(user.userId, session.sessionId).map((t) => ({
        turn_id: t.turnId,
        user_message: t.userMessage,
        assistant_message: t.assistantMessage,
        created_at: t.createdAt,
        sources: store.listSources(t.turnId).map(sourceJson),
      })),
    });
  });

  // Body: {user_id, message, session_id?}. Without session_id a new session is
  // started. Replies as server-sent events:
  //   recall {looked_for, found, turn_ids}             memory was looked up for this message
  //   token {text}                                     one per piece of the answer, in order
  //   search {queries}                                 the agent started a round of web searches
  //   sources {sources: [{n, url, title}], failed}     that round finished; failed lists queries that got no answer
  //   done  {turn_id, session_id, ttft_ms, total_ms}   after the last token; the turn is stored
  //   title {session_id, title}                        after done, on a session's first turn
  // After done the turn is filed for memory (answer record, profile, summary); that never delays or fails the reply.
  //   error {turn_id, message}                         if the model call failed; nothing is stored
  app.post('/api/chat', async (c) => {
    const receivedAt = performance.now();
    const body = await c.req.json().catch(() => null);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({ error: 'message is required' }, 400);
    if (message.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }, 400);
    }
    const user = store.getUser(typeof body.user_id === 'string' ? body.user_id : '');
    if (!user) return c.json({ error: 'unknown user' }, 404);
    let session: Session | undefined;
    if (body.session_id !== undefined && body.session_id !== null) {
      session = store.getSession(user.userId, String(body.session_id));
      if (!session) return c.json({ error: 'unknown session' }, 404);
    }

    const turnId = randomUUID();
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      let ttftMs: number | undefined;
      let answer = '';
      let totalMs = 0;
      let firstTurn = true;
      const registry = new SourceRegistry();

      try {
        const history = await timed(store, turnId, 'build_context', () => {
          if (!session) return [];
          const turns = store.listTurns(user.userId, session.sessionId, HISTORY_MAX_TURNS);
          firstTurn = turns.length === 0;
          return buildSessionHistory(turns);
        });

        // Memory. Dates are resolved by code. Only a message with a date or a
        // memory phrase is looked at further; everything else goes straight to the model.
        const now = deps.clock.now();
        const mentions = resolveDates(message, now, user.timezone);
        let recalled: string | undefined;
        let recheck: string | undefined;
        let mayNotSearch = false;
        if (mentions.length > 0 || hasMemoryCue(message)) {
          // A memory question with a date is settled by code; the rest asks the fast model.
          const understood = await timed(
            store,
            turnId,
            'understand',
            () =>
              understandPlainRecall(message, mentions) ??
              understandDatedMemory(message, mentions, localDay(now, user.timezone)) ??
              understandQuery(deps.model, deps.understandPrompt, { message, now, timezone: user.timezone, mentions }),
          );
          if (understood.needsRecall) {
            const found = await timed(store, turnId, 'recall', () =>
              recall(store, {
                userId: user.userId,
                timezone: user.timezone,
                ranges: understood.ranges,
                topics: understood.topics,
                softTopics: understood.softTopics,
                today: localDay(now, user.timezone),
              }),
            );
            recalled = formatRecalled(found, user.timezone);
            mayNotSearch = !understood.needsSearch;
            await stream.writeSSE({
              event: 'recall',
              data: JSON.stringify({
                looked_for: describeLookup(found),
                found: found.turns.length,
                turn_ids: found.turns.map((t) => t.turnId),
              }),
            });

            // Re-check: the question is also about now, and the recalled answers
            // left records of what they claimed. Search once per stored entity
            // before the model is called, so it can compare then with now straight away.
            if (understood.needsSearch) {
              const records = found.turns
                .map((t) => store.getAnswerRecord(t.turnId))
                .filter((r): r is AnswerRecord => r !== undefined);
              const plan = planRecheck(records, localDay(now, user.timezone).slice(0, 4));
              if (plan.items.length > 0) {
                await stream.writeSSE({
                  event: 'search',
                  data: JSON.stringify({ queries: plan.items.map((i) => i.query) }),
                });
                const checked = await runRecheck(plan, found.turns, user.timezone, {
                  search: deps.search,
                  metrics: store,
                  turnId,
                  registry,
                  signal: abort.signal,
                });
                recheck = checked.block;
                await stream.writeSSE({
                  event: 'sources',
                  data: JSON.stringify({
                    sources: checked.outcomes.flatMap((o) => o.results.map(({ content: _c, ...s }) => sourceJson(s))),
                    failed: checked.outcomes.filter((o) => o.status === 'failed').map((o) => o.query),
                  }),
                });
              }
            }
          }
        }

        const events = runAgent({
          model: deps.model,
          search: deps.search,
          metrics: store,
          turnId,
          system: buildSystemPrompt(deps.systemPrompt, {
            now,
            timezone: user.timezone,
            profile: user.profile,
            summary: session?.summary,
            recalled,
            recheck,
          }),
          // A question that is only about what was said before is answered from the records, without the web.
          // A re-check has already used one of the three search rounds.
          ...(mayNotSearch ? { maxRounds: 0 } : recheck ? { maxRounds: MAX_SEARCH_ROUNDS - 1 } : {}),
          messages: [...history, { role: 'user', content: message }],
          registry,
          signal: abort.signal,
        });
        for await (const event of events) {
          if (event.type === 'search') {
            await stream.writeSSE({ event: 'search', data: JSON.stringify({ queries: event.queries }) });
          } else if (event.type === 'search_done') {
            await stream.writeSSE({
              event: 'sources',
              data: JSON.stringify({ sources: event.sources.map(sourceJson), failed: event.failed }),
            });
          } else {
            if (ttftMs === undefined) {
              ttftMs = performance.now() - receivedAt;
              store.record({
                turnId,
                step: 'first_token',
                startedMs: Date.now() - ttftMs,
                durationMs: ttftMs,
                status: 'ok',
              });
            }
            answer += event.text;
            await stream.writeSSE({ event: 'token', data: JSON.stringify({ text: event.text }) });
          }
        }
        totalMs = performance.now() - receivedAt; // turn latency ends at the last token
        if (abort.signal.aborted) return; // the reader left mid-answer; keep no half turn
        if (!answer) throw new Error('the model returned no text');
      } catch (err) {
        if (abort.signal.aborted) return;
        logError(`[${turnId}] turn failed`, err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ turn_id: turnId, message: userMessageFor(err) }),
        });
        return;
      }

      // Write-back: starts after the last token, so it adds nothing to turn latency.
      const storedAt = deps.clock.now();
      const stored = await timed(store, turnId, 'store_turn', () => {
        const now = storedAt;
        const target = session ?? store.createSession(user.userId, now);
        store.addTurn({
          turnId,
          sessionId: target.sessionId,
          userId: user.userId,
          userMessage: message,
          assistantMessage: answer,
          createdAt: now,
          userTimezone: user.timezone,
        }, registry.all());
        return target;
      });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          turn_id: turnId,
          session_id: stored.sessionId,
          ttft_ms: ttftMs === undefined ? null : Math.round(ttftMs),
          total_ms: Math.round(totalMs),
        }),
      });

      deps.log?.(turnLine(turnId, ttftMs, totalMs, store.listMetrics(turnId)));

      // File the turn for memory. One fast-model call, after the reply is complete.
      const filed = await timed(store, turnId, 'write_back', async () => {
        const sessionNow = store.getSession(user.userId, stored.sessionId)!;
        // A turn older than the history window that the summary does not cover yet.
        const agingTurn =
          store.countTurns(stored.sessionId) - HISTORY_MAX_TURNS > sessionNow.summaryTurns
            ? store.turnAt(user.userId, stored.sessionId, sessionNow.summaryTurns)
            : undefined;
        const result = await runWriteback(deps.model, deps.writebackPrompt, {
          userMessage: message,
          answer,
          sources: registry.all(),
          asOf: localDay(storedAt, user.timezone),
          firstTurn,
          profile: store.getUser(user.userId)?.profile ?? user.profile,
          ...(agingTurn ? { aging: { turn: agingTurn, summary: sessionNow.summary } } : {}),
        });
        if (result.title) store.setSessionTitle(stored.sessionId, result.title);
        if (result.record) {
          store.setAnswerRecord({ turnId, ...result.record, createdAt: storedAt.toISOString() });
        }
        if (result.profile) store.setProfile(user.userId, result.profile);
        if (result.summary && agingTurn) {
          store.setSessionSummary(stored.sessionId, result.summary, sessionNow.summaryTurns + 1);
        }
        return result;
      }).catch((err) => {
        logError(`[${turnId}] write-back failed`, err);
        return undefined;
      });
      if (filed?.title) {
        await stream
          .writeSSE({ event: 'title', data: JSON.stringify({ session_id: stored.sessionId, title: filed.title }) })
          .catch(() => {}); // the reader may have left; the title is stored either way
      }
    });
  });

  app.get('/vendor/:file', async (c) => {
    const path = VENDOR[c.req.param('file')];
    if (!path) return c.notFound();
    return c.body(await readFile(path, 'utf8'), 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'max-age=3600',
    });
  });

  app.use('/*', serveStatic({ root: deps.webRoot ?? './web' }));

  return app;
}
