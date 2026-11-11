// HTTP routes: the streaming chat endpoint and the static chat page.
import { randomUUID } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ModelProvider } from '../llm/provider.ts';
import { type MetricsSink, timed } from '../telemetry/timed.ts';

export interface AppDeps {
  model: ModelProvider;
  metrics: MetricsSink;
  systemPrompt: string;
  /** Folder holding the static chat page, relative to the working directory. */
  webRoot?: string;
}

const MAX_MESSAGE_CHARS = 8000;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Replies as server-sent events:
  //   token {text}                          one per piece of the answer, in order
  //   done  {turn_id, ttft_ms, total_ms}    after the last token
  //   error {turn_id, message}              if the model call failed
  app.post('/api/chat', async (c) => {
    const receivedAt = performance.now();
    const body = await c.req.json().catch(() => null);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({ error: 'message is required' }, 400);
    if (message.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }, 400);
    }

    const turnId = randomUUID();
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      let ttftMs: number | undefined;
      try {
        await timed(deps.metrics, turnId, 'model_stream', async () => {
          const result = deps.model.streamText({
            model: 'main',
            system: deps.systemPrompt,
            messages: [{ role: 'user', content: message }],
            signal: abort.signal,
          });
          for await (const text of result.textStream) {
            if (!text) continue;
            if (ttftMs === undefined) {
              ttftMs = performance.now() - receivedAt;
              deps.metrics.record({
                turnId,
                step: 'first_token',
                startedMs: Date.now() - ttftMs,
                durationMs: ttftMs,
                status: 'ok',
              });
            }
            await stream.writeSSE({ event: 'token', data: JSON.stringify({ text }) });
          }
        });
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            turn_id: turnId,
            ttft_ms: ttftMs === undefined ? null : Math.round(ttftMs),
            total_ms: Math.round(performance.now() - receivedAt),
          }),
        });
      } catch (err) {
        if (abort.signal.aborted) return; // the reader left; nothing to tell them
        console.error(`[${turnId}] model call failed: ${err instanceof Error ? err.message : err}`);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            turn_id: turnId,
            message: 'The model could not answer. Please try again.',
          }),
        });
      }
    });
  });

  app.use('/*', serveStatic({ root: deps.webRoot ?? './web' }));

  return app;
}
