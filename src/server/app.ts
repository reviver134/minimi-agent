// HTTP routes: users, sessions, the streaming chat endpoint and the static chat page.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HISTORY_MAX_TURNS, buildSessionHistory, describeLookup, formatRecalled } from '../agent/context.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from '../agent/prompt.ts';
import { hasMemoryCue, understandPlainRecall, understandQuery } from '../agent/understand.ts';
import { type Source, SourceRegistry } from '../agent/webSearch.ts';
import type { ModelProvider } from '../llm/provider.ts';
import { recall } from '../memory/recall.ts';
import { type Session, type Store, normaliseName } from '../memory/store.ts';
import { makeTitle } from '../memory/title.ts';
import type { SearchProvider } from '../search/provider.ts';
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
  titlePrompt: string;
  /** The prompt of the query-understanding call (prompts/understand.md). */
  understandPrompt: string;
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
  //   recall {looked_for, found}                       memory was looked up for this message
  //   token {text}                                     one per piece of the answer, in order
  //   search {queries}                                 the agent started a round of web searches
  //   sources {sources: [{n, url, title}], failed}     that round finished; failed lists queries that got no answer
  //   done  {turn_id, session_id, ttft_ms, total_ms}   after the last token; the turn is stored
  //   title {session_id, title}                        after done, on a session's first turn
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
        let mayNotSearch = false;
        if (mentions.length > 0 || hasMemoryCue(message)) {
          // A plain "what did I ask on <date>" is settled by code; the rest asks the fast model.
          const understood = await timed(
            store,
            turnId,
            'understand',
            () =>
              understandPlainRecall(message, mentions) ??
              understandQuery(deps.model, deps.understandPrompt, { message, now, timezone: user.timezone, mentions }),
          );
          if (understood.needsRecall) {
            const found = await timed(store, turnId, 'recall', () =>
              recall(store, {
                userId: user.userId,
                timezone: user.timezone,
                ranges: understood.ranges,
                topics: understood.topics,
                today: localDay(now, user.timezone),
              }),
            );
            recalled = formatRecalled(found, user.timezone);
            mayNotSearch = !understood.needsSearch;
            await stream.writeSSE({
              event: 'recall',
              data: JSON.stringify({ looked_for: describeLookup(found), found: found.turns.length }),
            });
          }
        }

        const events = runAgent({
          model: deps.model,
          search: deps.search,
          metrics: store,
          turnId,
          system: buildSystemPrompt(deps.systemPrompt, { now, timezone: user.timezone, recalled }),
          // A question that is only about what was said before is answered from the records, without the web.
          ...(mayNotSearch ? { maxRounds: 0 } : {}),
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
        console.error(`[${turnId}] model call failed: ${err instanceof Error ? err.message : err}`);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            turn_id: turnId,
            message: 'The model could not answer. Please try again.',
          }),
        });
        return;
      }

      // Write-back: starts after the last token, so it adds nothing to turn latency.
      const stored = await timed(store, turnId, 'store_turn', () => {
        const now = deps.clock.now();
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

      if (firstTurn) {
        const title = await timed(store, turnId, 'title', async () => {
          const made = await makeTitle(deps.model, deps.titlePrompt, message);
          store.setSessionTitle(stored.sessionId, made.title);
          return made.title;
        });
        await stream
          .writeSSE({ event: 'title', data: JSON.stringify({ session_id: stored.sessionId, title }) })
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
