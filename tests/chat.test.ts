import { describe, expect, it } from 'vitest';
import { MockModel } from '../src/llm/mock.ts';
import { createApp } from '../src/server/app.ts';
import { MemoryMetrics } from '../src/telemetry/timed.ts';

interface SseEvent {
  event: string;
  data: any;
  atMs: number;
}

function setup(model: MockModel) {
  const metrics = new MemoryMetrics();
  const app = createApp({ model, metrics, systemPrompt: 'You are a test.' });
  const chat = (body: unknown) =>
    app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { metrics, chat };
}

/** Reads the event stream, noting when each event arrived. */
async function readEvents(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const t0 = performance.now();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) events.push({ event, data: JSON.parse(data), atMs: performance.now() - t0 });
    }
  }
  return events;
}

describe('POST /api/chat', () => {
  // S1-T3
  it('streams tokens incrementally and in order', async () => {
    const chunks = ['One', ' two', ' three', ' four', ' five.'];
    const model = new MockModel({ chunks, delayMs: 40 });
    const { chat, metrics } = setup(model);

    const response = await chat({ message: 'count to five' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await readEvents(response);
    const tokens = events.filter((e) => e.event === 'token');
    expect(tokens.map((e) => e.data.text)).toEqual(chunks);

    // Incremental: the first token arrives well before the last one is produced.
    const first = tokens[0]!.atMs;
    const last = tokens.at(-1)!.atMs;
    expect(last - first).toBeGreaterThanOrEqual(100);
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.atMs).toBeGreaterThan(tokens[i - 1]!.atMs);
    }

    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.ttft_ms).toBeLessThan(done.data.total_ms);

    expect(model.requests[0]!.system).toBe('You are a test.');
    expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'count to five' }]);

    const steps = metrics.metrics.filter((m) => m.turnId === done.data.turn_id);
    expect(steps.map((m) => m.step).sort()).toEqual(['first_token', 'model_stream']);
    expect(steps.every((m) => m.status === 'ok')).toBe(true);
  });

  it('sends an error event when the model fails mid-stream', async () => {
    const model = new MockModel({ chunks: ['Half'], failWith: new Error('upstream secret detail') });
    const { chat, metrics } = setup(model);

    const events = await readEvents(await chat({ message: 'hello' }));
    expect(events.map((e) => e.event)).toEqual(['token', 'error']);
    expect(events[1]!.data.message).not.toContain('secret');
    expect(metrics.metrics.find((m) => m.step === 'model_stream')!.status).toBe('error');
  });

  it('rejects an empty message', async () => {
    const { chat } = setup(new MockModel());
    expect((await chat({ message: '   ' })).status).toBe(400);
    expect((await chat({})).status).toBe(400);
  });
});
