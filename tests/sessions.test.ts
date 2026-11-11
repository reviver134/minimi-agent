import { describe, expect, it } from 'vitest';
import { HISTORY_MAX_CHARS, buildSessionHistory } from '../src/agent/context.ts';
import { MockModel } from '../src/llm/mock.ts';
import type { Turn } from '../src/memory/store.ts';
import { fixedClock } from '../src/temporal/clock.ts';
import { readEvents, setup } from './helpers.ts';

const doneOf = (events: Awaited<ReturnType<typeof readEvents>>) =>
  events.find((e) => e.event === 'done')!.data;

describe('sessions', () => {
  // S2-T3
  it('keeps two users apart', async () => {
    const { app, chat, signIn } = setup(new MockModel());
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    expect(alice.user_id).not.toBe(bob.user_id);

    const question = 'Which test runner should I use?';
    const a = doneOf(await readEvents(await chat({ user_id: alice.user_id, message: question })));
    const b = doneOf(await readEvents(await chat({ user_id: bob.user_id, message: question })));
    expect(a.session_id).not.toBe(b.session_id);

    const sessionsOf = async (userId: string) => {
      const response = await app.request(`/api/sessions?user_id=${userId}`);
      return ((await response.json()) as any).sessions.map((s: any) => s.session_id);
    };
    expect(await sessionsOf(alice.user_id)).toEqual([a.session_id]);
    expect(await sessionsOf(bob.user_id)).toEqual([b.session_id]);

    // Bob cannot read Alice's turns or write into her session.
    const peek = await app.request(`/api/sessions/${a.session_id}/turns?user_id=${bob.user_id}`);
    expect(peek.status).toBe(404);
    const intrude = await chat({ user_id: bob.user_id, session_id: a.session_id, message: 'hi' });
    expect(intrude.status).toBe(404);

    const own = await app.request(`/api/sessions/${a.session_id}/turns?user_id=${alice.user_id}`);
    const turns = ((await own.json()) as any).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0].user_message).toBe(question);

    expect((await app.request('/api/sessions?user_id=nobody')).status).toBe(404);
  });

  // S2-T4
  it('sets the title after the stream ends without adding to turn latency', async () => {
    const model = new MockModel({ chunks: ['Use', ' Vitest.'], fast: { chunks: ['Test runners'], delayMs: 300 } });
    const { chat, signIn, store } = setup(model);
    const user = await signIn('demo');

    let titleAtDone: string | null | undefined = 'unset';
    const events = await readEvents(
      await chat({ user_id: user.user_id, message: 'Which test runner should I use?' }),
      (e) => {
        if (e.event === 'done') titleAtDone = store.getSession(user.user_id, e.data.session_id)?.title;
      },
    );
    expect(events.map((e) => e.event)).toEqual(['token', 'token', 'done', 'title']);
    const done = events[2]!;
    const title = events[3]!;

    // The reply was complete, and stored, before the title existed.
    expect(titleAtDone).toBeNull();
    expect(done.data.total_ms).toBeLessThan(200);
    expect(title.atMs - done.atMs).toBeGreaterThanOrEqual(250);
    expect(title.data).toEqual({ session_id: done.data.session_id, title: 'Test runners' });
    expect(store.getSession(user.user_id, done.data.session_id)!.title).toBe('Test runners');

    // A second turn in the same session keeps the title and makes no title call.
    const second = await readEvents(
      await chat({ user_id: user.user_id, session_id: done.data.session_id, message: 'And for React?' }),
    );
    expect(second.map((e) => e.event)).toEqual(['token', 'token', 'done']);
    expect(model.requests.filter((r) => r.model === 'fast')).toHaveLength(1);
  });

  it('falls back to the start of the message when the title call fails', async () => {
    const model = new MockModel({ fast: { chunks: [], failWith: new Error('rate limit') } });
    const { chat, signIn, store } = setup(model);
    const user = await signIn('demo');
    const events = await readEvents(await chat({ user_id: user.user_id, message: 'Compare managed Postgres hosting.' }));
    expect(events.at(-1)!.event).toBe('title');
    expect(store.listSessions(user.user_id)[0]!.title).toBe('Compare managed Postgres hosting');
  });

  // S2-T5
  it('puts the last 5 turns in context and stays under the size cap', async () => {
    const long = (label: string) => `${label} ${'lorem ipsum dolor sit amet '.repeat(200)}`; // ~5,400 chars
    const turns: Turn[] = Array.from({ length: 8 }, (_, i) => ({
      turnId: `t${i + 1}`,
      sessionId: 's',
      userId: 'u',
      userMessage: long(`question ${i + 1}`),
      assistantMessage: long(`answer ${i + 1}`),
      createdAt: `2026-11-09T08:0${i}:00.000Z`,
      userTimezone: 'Asia/Kolkata',
    }));

    const history = buildSessionHistory(turns);
    expect(history).toHaveLength(10);
    expect(history.map((m) => m.role).slice(0, 2)).toEqual(['user', 'assistant']);
    expect(history[0]!.content.startsWith('question 4 ')).toBe(true);
    expect(history[9]!.content.startsWith('answer 8 ')).toBe(true);
    const size = history.reduce((n, m) => n + m.content.length, 0);
    expect(size).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(history[0]!.content.endsWith('…[cut]')).toBe(true);

    // Short turns are passed through whole.
    const short = buildSessionHistory([{ ...turns[0]!, userMessage: 'My name is X', assistantMessage: 'Hello X' }]);
    expect(short).toEqual([
      { role: 'user', content: 'My name is X' },
      { role: 'assistant', content: 'Hello X' },
    ]);
  });

  it('sends the session history to the model, through the endpoint', async () => {
    const model = new MockModel({ chunks: ['ok'] });
    const { chat, signIn } = setup(model);
    const user = await signIn('demo');
    let sessionId: string | undefined;
    for (let i = 1; i <= 7; i++) {
      const events = await readEvents(await chat({ user_id: user.user_id, session_id: sessionId, message: `message ${i}` }));
      sessionId = doneOf(events).session_id;
    }
    const last = model.requests.filter((r) => r.model === 'main').at(-1)!;
    expect(last.messages.flatMap((m) => (m.role === 'user' ? [m.content] : []))).toEqual([
      'message 2',
      'message 3',
      'message 4',
      'message 5',
      'message 6',
      'message 7',
    ]);
  });

  // S2-T6, through the endpoint
  it('stores the turn in UTC with the timezone the user signed in with', async () => {
    const { chat, signIn, store } = setup(new MockModel(), fixedClock('2026-11-07T01:15:00+05:30'));
    const user = await signIn('demo', 'Asia/Kolkata');
    const done = doneOf(await readEvents(await chat({ user_id: user.user_id, message: 'laptops?' })));
    const turn = store.listTurns(user.user_id, done.session_id)[0]!;
    expect(turn.createdAt).toBe('2026-11-06T19:45:00.000Z');
    expect(turn.userTimezone).toBe('Asia/Kolkata');
    expect((await signIn('other', 'Not/AZone')).timezone).toBe('UTC');
  });
});
