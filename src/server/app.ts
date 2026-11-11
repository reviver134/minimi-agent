// HTTP routes: users, sessions, the streaming chat endpoint and the static chat page.
import { randomUUID } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HISTORY_MAX_TURNS, buildSessionHistory } from '../agent/context.ts';
import type { ModelProvider } from '../llm/provider.ts';
import { type Session, type Store, normaliseName } from '../memory/store.ts';
import { makeTitle } from '../memory/title.ts';
import { timed } from '../telemetry/timed.ts';
import { type Clock, isTimezone } from '../temporal/clock.ts';

export interface AppDeps {
  model: ModelProvider;
  /** Holds users, sessions and turns, and records the metrics of every turn. */
  store: Store;
  clock: Clock;
  systemPrompt: string;
  titlePrompt: string;
  /** Folder holding the static chat page, relative to the working directory. */
  webRoot?: string;
}

const MAX_MESSAGE_CHARS = 8000;
const MAX_NAME_CHARS = 60;

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
      })),
    });
  });

  // Body: {user_id, message, session_id?}. Without session_id a new session is
  // started. Replies as server-sent events:
  //   token {text}                                     one per piece of the answer, in order
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

      try {
        const history = await timed(store, turnId, 'build_context', () => {
          if (!session) return [];
          const turns = store.listTurns(user.userId, session.sessionId, HISTORY_MAX_TURNS);
          firstTurn = turns.length === 0;
          return buildSessionHistory(turns);
        });

        await timed(store, turnId, 'model_stream', async (tokens) => {
          const result = deps.model.streamText({
            model: 'main',
            system: deps.systemPrompt,
            messages: [...history, { role: 'user', content: message }],
            signal: abort.signal,
          });
          for await (const text of result.textStream) {
            if (!text) continue;
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
            answer += text;
            await stream.writeSSE({ event: 'token', data: JSON.stringify({ text }) });
          }
          totalMs = performance.now() - receivedAt; // turn latency ends at the last token
          const usage = await result.usage;
          tokens.tokensIn = usage.tokensIn;
          tokens.tokensOut = usage.tokensOut;
        });
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
        });
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

  app.use('/*', serveStatic({ root: deps.webRoot ?? './web' }));

  return app;
}
