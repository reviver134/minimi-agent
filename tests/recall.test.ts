import { describe, expect, it } from 'vitest';
import { SEED_TURNS, seedDemo } from '../evals/seed.ts';
import { formatRecalled } from '../src/agent/context.ts';
import {
  hasMemoryCue,
  understandByRules,
  understandDatedMemory,
  understandPlainRecall,
  understandQuery,
} from '../src/agent/understand.ts';
import { MockModel } from '../src/llm/mock.ts';
import { cleanTopics, recall } from '../src/memory/recall.ts';
import { Store } from '../src/memory/store.ts';
import { fixedClock } from '../src/temporal/clock.ts';
import { resolveDates } from '../src/temporal/dates.ts';
import { readEvents, setup } from './helpers.ts';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-11T10:00:00+05:30');
const TODAY = '2026-11-11';

function seeded() {
  const store = new Store(':memory:');
  const { userId } = seedDemo(store);
  /** Recall for the date phrase in the message, the way the chat endpoint does it. */
  const ask = (message: string, topics: string[] = [], as = userId) =>
    recall(store, {
      userId: as,
      timezone: TZ,
      ranges: resolveDates(message, NOW, TZ).flatMap((m) => m.candidates),
      topics,
      today: TODAY,
    });
  return { store, userId, ask };
}

const ids = (result: ReturnType<typeof recall>) => result.turns.map((t) => t.turnId);

describe('recall on the seeded history', () => {
  it('seeds once', () => {
    const { store, userId } = seeded();
    expect(seedDemo(store).added).toBe(0);
    expect(store.listSessions(userId).map((s) => s.title).sort()).toEqual([
      'CRM shortlist',
      'Laptops',
      'Postgres hosting',
      'Test runners',
    ]);
    expect(store.listSources('seed-crm')).toHaveLength(5);
  });

  // S4-T5
  it('finds the 01:15 turn of 7 November under 7 November, not 6 November', () => {
    const { store, ask } = seeded();
    expect(SEED_TURNS[2]!.turnId).toBe('seed-laptops');
    expect(new Date(SEED_TURNS[2]!.at).toISOString()).toBe('2026-11-06T19:45:00.000Z');
    expect(ids(ask('What did I ask you on 7 November?'))).toEqual(['seed-laptops']);
    expect(ids(ask('What did I ask you on 6 November?'))).toEqual([]);
    store.close();
  });

  // S4-T6
  it('returns both turns of 3 November', () => {
    const result = seeded().ask('What did I ask you on 3 November?');
    expect(ids(result)).toEqual(['seed-postgres', 'seed-test-runners']);
    expect(result.turns[0]!.sessionTitle).toBe('Postgres hosting');
    expect(result.nearest).toEqual([]);
  });

  // S4-T7
  it('returns only the Postgres turn for "last Tuesday" plus the topic', () => {
    const { ask } = seeded();
    const result = ask('What did I ask you last Tuesday about Postgres?', ['Postgres hosting']);
    expect(result.ranges).toEqual([
      { from: '2026-11-10', to: '2026-11-10' },
      { from: '2026-11-03', to: '2026-11-03' },
    ]);
    expect(ids(result)).toEqual(['seed-postgres']);
    expect(result.topicMissed).toBe(false);
  });

  // S4-T8
  it('returns nothing for an empty day, with the nearest days that have turns', () => {
    const { ask } = seeded();
    const result = ask('What did I ask you on 6 November?');
    expect(result.turns).toEqual([]);
    expect(result.nearest).toEqual([
      {
        day: '2026-11-03',
        questions: ['Compare managed Postgres hosting for a small SaaS', 'Which test runner should I use for a new Node project?'],
      },
      { day: '2026-11-07', questions: ['Good laptop for local model work under $2,000?'] },
    ]);

    // Before the first record there is only a later day (E1).
    const october = ask('What did I ask you on 1 October?');
    expect(october.turns).toEqual([]);
    expect(october.nearest.map((n) => n.day)).toEqual(['2026-11-03']);

    const text = formatRecalled(result, TZ);
    expect(text).toContain('Looked for: Friday 6 November 2026.');
    expect(text).toContain('No records found.');
    expect(text).toContain('- Saturday 7 November 2026: asked "Good laptop for local model work under $2,000?"');
  });

  // S4-T9
  it('returns nothing to a different user', () => {
    const { store, ask } = seeded();
    const other = store.getOrCreateUser('other', TZ, NOW);
    for (const message of ['What did I ask you on Monday?', 'What did I ask you on 3 November?', 'What have I asked you this month?']) {
      const result = ask(message, [], other.userId);
      expect(result.turns).toEqual([]);
      expect(result.nearest).toEqual([]);
    }
    expect(ids(ask('', ['crm'], other.userId))).toEqual([]);
    expect(formatRecalled(ask('What did I ask you on Monday?', [], other.userId), TZ)).toContain(
      'This user has no stored conversations on any other day either',
    );
  });

  // S4-T10
  it('answers a recall query on 5,000 turns in under 20 ms', () => {
    const store = new Store(':memory:');
    const { userId } = seedDemo(store);
    const session = store.createSession(userId, new Date('2026-01-01T00:00:00Z'), 'Bulk');
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5000; i++) {
      store.addTurn({
        turnId: `bulk-${i}`,
        sessionId: session.sessionId,
        userId,
        userMessage: `Question ${i} about topic ${i % 97}`,
        assistantMessage: `Answer ${i}. `.repeat(20),
        createdAt: new Date(start + i * 5_400_000), // every 90 minutes, to past October
        userTimezone: TZ,
      });
    }
    const query = {
      userId,
      timezone: TZ,
      ranges: [{ from: '2026-11-03', to: '2026-11-03' }],
      topics: ['postgres'],
      today: TODAY,
    };
    recall(store, query); // first call prepares the statements
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const result = recall(store, query);
      times.push(performance.now() - t0);
      expect(ids(result)).toEqual(['seed-postgres']);
    }
    times.sort((a, b) => a - b);
    expect(times[10]!).toBeLessThan(20);
  });

  it('covers the other eval lookups', () => {
    const { ask } = seeded();
    // C2: Monday
    expect(ids(ask('What did we talk about on Monday?'))).toEqual(['seed-crm', 'seed-preference']);
    // C6: this month
    expect(ids(ask('What have I asked you this month?'))).toHaveLength(5);
    // D4: last week, by topic
    expect(ids(ask('Are those laptop prices from last week still right?', ['laptop']))).toEqual(['seed-laptops']);
    // D5: no date, topic only
    expect(ids(ask('Which of the CRMs you shortlisted is cheapest for 20 seats?', ['CRMs']))).toEqual(['seed-crm']);
    // E2: a topic that was never discussed: the period is returned, and flagged
    const mongo = ask('Last week you told me to use MongoDB. Why?', ['mongodb']);
    expect(mongo.topicMissed).toBe(true);
    expect(ids(mongo)).toEqual(['seed-postgres', 'seed-test-runners', 'seed-laptops']);
    expect(formatRecalled(mongo, TZ)).toContain('No record from this period mentions mongodb.');
    // E3: a day before any record
    expect(ask('What did I ask you on 25 December?').nearest.map((n) => n.day)).toEqual(['2026-11-03']);
    // G5: the future
    const next = ask('What will I ask you next Tuesday?');
    expect(next.future).toBe(true);
    expect(formatRecalled(next, TZ)).toContain('That is in the future');
  });

  it('writes records with their local date and time, without old citation numbers', () => {
    const text = formatRecalled(seeded().ask('What did I ask you on 7 November?'), TZ);
    expect(text.startsWith('<recalled_records>\nLooked for: Saturday 7 November 2026.')).toBe(true);
    expect(text).toContain('<record date="Saturday 7 November 2026" time="01:15" chat="Laptops">');
    expect(text).toContain('User asked: Good laptop for local model work under $2,000?');
    expect(text).toContain('| Apple MacBook Air 15-inch (M4, 24 GB) | $1,599 |');
    expect(text).not.toMatch(/\[\d\]/);
    expect(text.endsWith('</recalled_records>')).toBe(true);
  });

  it('cleans topic words', () => {
    expect(cleanTopics(['Postgres hosting', 'CRMs', 'the price in November', 'C++', 'node.js'])).toEqual([
      'postgres',
      'hosting',
      'crms',
      'c++',
      'node.js',
    ]);
  });
});

describe('query understanding', () => {
  const input = (message: string) => ({ message, now: NOW, timezone: TZ, mentions: resolveDates(message, NOW, TZ) });

  it('spots messages that lean on memory, and leaves the rest alone', () => {
    for (const m of [
      'Which of the CRMs you shortlisted is cheapest?',
      'You told me to use MongoDB. Why?',
      'Is your answer still correct?',
      'what did we discuss',
      'remember the laptops?',
    ]) {
      expect(hasMemoryCue(m), m).toBe(true);
    }
    for (const m of ['Hi, how are you?', 'Explain what a database index is in two sentences.', 'Thanks, that helps.', 'Compare three password managers.']) {
      expect(hasMemoryCue(m), m).toBe(false);
    }
  });

  it('settles a plain "what did I ask on <date>" without a model call', () => {
    const plain = (message: string) => understandPlainRecall(message, resolveDates(message, NOW, TZ));
    expect(plain('What did I ask you on 3 November?')).toEqual({
      needsRecall: true,
      needsSearch: false,
      topics: [],
      ranges: [{ from: '2026-11-03', to: '2026-11-03' }],
      fromModel: false,
    });
    expect(plain('What did I ask you last Tuesday about Postgres?')!.topics).toEqual(['Postgres']);
    expect(plain('What did we talk about on Monday?')!.topics).toEqual([]);
    expect(plain('What have I asked you this month?')!.ranges).toEqual([{ from: '2026-11-01', to: '2026-11-11' }]);
    expect(plain('What did I ask you on 25 December?')!.ranges).toEqual([{ from: '2025-12-25', to: '2025-12-25' }]);
    // Not plain: about the present, a claim to check, the future, or no date.
    for (const message of [
      'What did I ask you on 3 November? Is your answer still correct today?',
      'Last week you told me to use MongoDB. Why?',
      'Are those laptop prices from last week still right?',
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      'What will I ask you next Tuesday?',
      'What did we discuss?',
      "Who won yesterday's match?",
    ]) {
      expect(plain(message), message).toBeUndefined();
    }
  });

  it('settles a dated memory question without a model call, and leaves the rest to the model', () => {
    const dated = (message: string) => understandDatedMemory(message, resolveDates(message, NOW, TZ), TODAY);
    // D3: about the present, so the web is allowed.
    const d3 = dated('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?')!;
    expect(d3.needsRecall).toBe(true);
    expect(d3.needsSearch).toBe(true);
    expect(d3.softTopics).toBe(true);
    expect(d3.ranges.map((r) => r.from)).toEqual(['2026-11-10', '2026-11-03']);
    // D2: "today" is not when the earlier conversation happened.
    expect(dated('What did I ask you on 3 November? Is your answer still correct today?')!.ranges).toEqual([
      { from: '2026-11-03', to: '2026-11-03' },
    ]);
    // E2: only about what was said, so no web.
    expect(dated('Last week you told me to use MongoDB. Why?')!.needsSearch).toBe(false);
    // Not settled by code: no memory phrase, or no date other than today.
    for (const message of [
      "Who won yesterday's match?",
      'Which of the CRMs you shortlisted is cheapest for 20 seats today?',
      'Is there a free tier for Supabase right now?',
    ]) {
      expect(dated(message), message).toBeUndefined();
    }
  });

  it('narrows by the words of the message without reporting a miss', () => {
    const { ask, store, userId } = seeded();
    const byWords = (message: string) => {
      const u = understandDatedMemory(message, resolveDates(message, NOW, TZ), TODAY)!;
      return recall(store, { userId, timezone: TZ, ranges: u.ranges, topics: u.topics, softTopics: true, today: TODAY });
    };
    // D4: three turns last week, only one about laptops.
    expect(ids(byWords('Are those laptop prices from last week still right?'))).toEqual(['seed-laptops']);
    // D1: the CRM turn, not the preference turn of the same day.
    expect(
      ids(byWords('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?')),
    ).toEqual(['seed-crm']);
    // D5 when the understanding call is down: no date, only the words of the message.
    // "cheapest" also appears in the laptop answer; the CRM turn matches more words and wins.
    const d5 = recall(store, {
      userId,
      timezone: TZ,
      ranges: [],
      topics: ['Which of the CRMs you shortlisted is cheapest for seats today?'],
      softTopics: true,
      today: TODAY,
    });
    expect(ids(d5)).toEqual(['seed-crm']);
    // D2: no subject word at all: the whole day, and no "no record mentions" note.
    const d2 = byWords('What did I ask you on 3 November? Is your answer still correct today?');
    expect(ids(d2)).toEqual(['seed-postgres', 'seed-test-runners']);
    expect(d2.topicMissed).toBe(false);
    expect(ask('x last week', ['mongodb']).topicMissed).toBe(true);
  });

  it('keeps only the date phrases the model says are about the earlier conversation', async () => {
    const message = 'What did I ask you on 3 November? Is your answer still correct today?';
    const model = new MockModel({ understand: { needs_search: true, topics: [], when: [1] } });
    const understood = await understandQuery(model, 'prompt', input(message));
    expect(understood).toEqual({
      needsRecall: true,
      needsSearch: true,
      topics: [],
      ranges: [{ from: '2026-11-03', to: '2026-11-03' }],
      fromModel: true,
    });
    // The model is given the dates code found and a calendar; it does no date arithmetic.
    const sent = model.requests[0]!;
    expect(sent.model).toBe('fast');
    const content = (sent.messages[0] as { content: string }).content;
    expect(content).toContain('Today: Wednesday 11 November 2026 (2026-11-11)');
    expect(content).toContain('1. "3 November" = 2026-11-03');
    expect(content).toContain('2026-11-10 Tuesday (yesterday)');
  });

  it("uses the model's own dates only when code found none, and only real past days", async () => {
    const ask = (understand: Record<string, unknown>) =>
      understandQuery(new MockModel({ understand }), 'prompt', input('what did we discuss at the start of the month'));
    expect((await ask({ date_from: '2026-11-01', date_to: '2026-11-05' })).ranges).toEqual([
      { from: '2026-11-01', to: '2026-11-05' },
    ]);
    expect((await ask({ date_from: '2026-12-01', date_to: '2026-12-05' })).ranges).toEqual([]);
    expect((await ask({ date_from: 'last week', date_to: null })).ranges).toEqual([]);
  });

  it('falls back to rules when the call fails, is slow or returns bad JSON', async () => {
    const message = 'What did I ask you on 3 November? Is your answer still correct today?';
    const byRules = understandByRules(message, resolveDates(message, NOW, TZ), TODAY);
    expect(byRules.ranges).toEqual([{ from: '2026-11-03', to: '2026-11-03' }]);

    for (const understand of [
      { chunks: [], failWith: new Error('rate limit') },
      { chunks: ['not json'] },
      { chunks: ['{"needs_recall": "yes"}'] },
    ]) {
      const result = await understandQuery(new MockModel({ understand }), 'prompt', input(message));
      expect(result.fromModel).toBe(false);
      expect(result.needsRecall).toBe(true);
      expect(result.ranges).toEqual(byRules.ranges);
    }
    const slow = await understandQuery(new MockModel({ understand: { chunks: ['{}'], delayMs: 500 } }), 'prompt', {
      ...input(message),
      timeoutMs: 50,
    });
    expect(slow.fromModel).toBe(false);
  });
});

describe('recall through the chat endpoint', () => {
  function chatAs(model: MockModel, name = 'demo') {
    const app = setup(model, fixedClock(NOW));
    seedDemo(app.store);
    const ask = async (message: string) => {
      const user = await app.signIn(name, TZ);
      return readEvents(await app.chat({ user_id: user.user_id, message }));
    };
    return { ...app, ask };
  }
  const mainRequests = (model: MockModel) => model.requests.filter((r) => r.model === 'main');

  it('gives the model the records and answers without the web (C1)', async () => {
    const model = new MockModel({ chunks: ['On 3 November you asked two things.'] });
    const { ask, store } = chatAs(model);
    const events = await ask('What did I ask you on 3 November?');

    expect(events.map((e) => e.event)).toEqual(['recall', 'token', 'done', 'title']);
    expect(events[0]!.data).toEqual({
      looked_for: 'Tuesday 3 November 2026',
      found: 2,
      turn_ids: ['seed-postgres', 'seed-test-runners'],
    });

    // Code understood this one: no call to the fast model before the answer.
    expect(model.requests.filter((r) => r.label === 'understand')).toHaveLength(0);
    const request = mainRequests(model)[0]!;
    expect(request.toolChoice).toBe('none');
    const system = request.system;
    expect(system).toContain('<record date="Tuesday 3 November 2026" time="11:00" chat="Postgres hosting">');
    expect(system).toContain('<record date="Tuesday 3 November 2026" time="16:30" chat="Test runners">');
    // Cache-friendly: the records come after the date, at the very end.
    expect(system.indexOf('<recalled_records>')).toBeGreaterThan(system.indexOf('</context>'));
    expect(system.trimEnd().endsWith('</recalled_records>')).toBe(true);

    const done = events.find((e) => e.event === 'done')!.data;
    expect(store.listMetrics(done.turn_id).map((m) => m.step)).toEqual([
      'build_context',
      'understand',
      'recall',
      'first_token',
      'model_round',
      'store_turn',
      'write_back',
    ]);
  });

  it('says so when there is no record, and offers the nearest day (C5)', async () => {
    const model = new MockModel();
    const events = await chatAs(model).ask('What did I ask you on 6 November?');
    expect(events[0]!.data).toEqual({ looked_for: 'Friday 6 November 2026', found: 0, turn_ids: [] });
    const system = mainRequests(model)[0]!.system;
    expect(system).toContain('No records found.');
    expect(system).toContain('- Saturday 7 November 2026: asked "Good laptop for local model work under $2,000?"');
    expect(system).not.toContain('<record ');
  });

  it('lets the model search when the question is also about now (D3)', async () => {
    const model = new MockModel({ understand: { needs_search: true, topics: ['postgres', 'hosting'], when: [1] } });
    await chatAs(model).ask('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
    const request = mainRequests(model)[0]!;
    expect(request.toolChoice).toBe('auto');
    expect(request.system).toContain('chat="Postgres hosting"');
    expect(request.system).not.toContain('chat="Test runners"');
  });

  it('leaks nothing to another user (E4)', async () => {
    const model = new MockModel();
    const events = await chatAs(model, 'other').ask('What did I ask you on Monday?');
    expect(events[0]!.data.found).toBe(0);
    const system = mainRequests(model)[0]!.system;
    expect(system).toContain('This user has no stored conversations on any other day either');
    for (const word of ['CRM', 'Postgres', 'laptop', 'Vitest']) expect(system).not.toContain(word);
  });

  it('skips memory for a message with no date and no memory phrase', async () => {
    const model = new MockModel();
    const events = await chatAs(model).ask('Explain what a database index is in two sentences.');
    expect(events.map((e) => e.event)).toEqual(['token', 'token', 'token', 'token', 'token', 'done', 'title']);
    expect(model.requests.filter((r) => r.label === 'understand')).toHaveLength(0);
    expect(mainRequests(model)[0]!.system).not.toContain('<recalled_records>');
    expect(mainRequests(model)[0]!.toolChoice).toBe('auto');
  });

  it('skips recall when the model says the message does not need it', async () => {
    const model = new MockModel({ understand: { needs_recall: false, needs_search: true } });
    const events = await chatAs(model).ask('Who won yesterday\'s match?');
    expect(events.some((e) => e.event === 'recall')).toBe(false);
    expect(mainRequests(model)[0]!.system).not.toContain('<recalled_records>');
  });

  it('still recalls by rules when the understanding call fails', async () => {
    const model = new MockModel({ understand: { chunks: [], failWith: new Error('down') } });
    // A memory question with no date goes to the model call; here that call is down.
    const events = await chatAs(model).ask('Which of the CRMs you shortlisted is cheapest?');
    expect(model.requests.filter((r) => r.label === 'understand')).toHaveLength(1);
    expect(events[0]!.event).toBe('recall');
    expect(events[0]!.data.found).toBeGreaterThan(0);
    expect(mainRequests(model)[0]!.system).toContain('chat="CRM shortlist"');
    expect(mainRequests(model)[0]!.toolChoice).toBe('auto');
  });
});
