import { describe, expect, it } from 'vitest';
import { MockModel } from '../src/llm/mock.ts';
import { readEvents, setup } from './helpers.ts';

describe('POST /api/chat', () => {
  // S1-T3
  it('streams tokens incrementally and in order', async () => {
    const chunks = ['One', ' two', ' three', ' four', ' five.'];
    const model = new MockModel({ chunks, delayMs: 40 });
    const { chat, signIn, store } = setup(model);
    const user = await signIn('demo');

    const response = await chat({ user_id: user.user_id, message: 'count to five' });
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

    const done = events.find((e) => e.event === 'done')!;
    expect(done.data.ttft_ms).toBeLessThan(done.data.total_ms);

    expect(model.requests[0]!.system).toBe('You are a test.');
    expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'count to five' }]);

    // Every step is written to turn_metrics against the turn_id.
    const steps = store.listMetrics(done.data.turn_id);
    expect(steps.map((m) => m.step)).toEqual([
      'build_context',
      'first_token',
      'model_stream',
      'store_turn',
      'title',
    ]);
    expect(steps.every((m) => m.status === 'ok')).toBe(true);
    const stream = steps.find((m) => m.step === 'model_stream')!;
    expect(stream.tokensIn).toBeGreaterThan(0);
    expect(stream.tokensOut).toBe(chunks.join('').length);
  });

  it('sends an error event when the model fails mid-stream and stores no turn', async () => {
    const model = new MockModel({ chunks: ['Half'], failWith: new Error('upstream secret detail') });
    const { chat, signIn, store } = setup(model);
    const user = await signIn('demo');

    const events = await readEvents(await chat({ user_id: user.user_id, message: 'hello' }));
    expect(events.map((e) => e.event)).toEqual(['token', 'error']);
    expect(events[1]!.data.message).not.toContain('secret');
    const steps = store.listMetrics(events[1]!.data.turn_id);
    expect(steps.find((m) => m.step === 'model_stream')!.status).toBe('error');
    expect(store.listSessions(user.user_id)).toEqual([]);
  });

  it('rejects an empty message, an unknown user and an unknown session', async () => {
    const { chat, signIn } = setup(new MockModel());
    const user = await signIn('demo');
    expect((await chat({ user_id: user.user_id, message: '   ' })).status).toBe(400);
    expect((await chat({ user_id: user.user_id })).status).toBe(400);
    expect((await chat({ user_id: 'nobody', message: 'hi' })).status).toBe(404);
    expect((await chat({ user_id: user.user_id, session_id: 'nope', message: 'hi' })).status).toBe(404);
  });
});
