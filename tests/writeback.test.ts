import { describe, expect, it } from 'vitest';
import { SEED_PROFILE, seedDemo } from '../evals/seed.ts';
import { planRecheck, runRecheck, stillStated } from '../src/agent/recheck.ts';
import { SourceRegistry } from '../src/agent/webSearch.ts';
import { MockModel } from '../src/llm/mock.ts';
import type { StreamRequest } from '../src/llm/provider.ts';
import { type AnswerRecord, buildRecord, cleanProfile } from '../src/memory/records.ts';
import { Store } from '../src/memory/store.ts';
import { runWriteback, writebackParts } from '../src/memory/writeback.ts';
import { MockSearch } from '../src/search/mock.ts';
import { MemoryMetrics } from '../src/telemetry/timed.ts';
import { fixedClock } from '../src/temporal/clock.ts';
import { readEvents, setup } from './helpers.ts';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-11T10:00:00+05:30');

// A fixture answer with six prices, in the shapes prices take: per month, per
// seat, with thousands separators, with cents, a range and another currency.
const ANSWER = [
  '| Tool | Plan | Price |',
  '|---|---|---|',
  '| Neon | Launch | $19/month [1] |',
  '| Supabase | Pro | $25 per month [2] |',
  '| Render | Basic-1gb | $19.00/mo [3] |',
  '| HubSpot | Starter | $20 per seat/month [1] |',
  '| Legion 5i | 32 GB | $1,449 [2] |',
  '| Hetzner | CX22 | €3.79 – €4.51/month [3] |',
].join('\n');
const SOURCES = [1, 2, 3].map((n) => ({ n, url: `https://example.com/${n}`, title: `Source ${n}` }));
const SIX = [
  { entity: 'Neon', attribute: 'Launch price', value: '$19/month', source_n: 1 },
  { entity: 'Supabase', attribute: 'Pro price', value: '$25 per month', source_n: 2 },
  { entity: 'Render', attribute: 'Basic-1gb price', value: '$19.00/mo', source_n: 3 },
  { entity: 'HubSpot', attribute: 'Starter price', value: '$20 per seat/month', source_n: 1 },
  { entity: 'Legion 5i', attribute: 'price', value: '$1,449', source_n: 2 },
  { entity: 'Hetzner', attribute: 'CX22 price', value: '€3.79 – €4.51/month', source_n: 3 },
];
const RECORD = {
  topic: 'hosting and tools prices',
  entities: SIX.map((c) => ({ name: c.entity, query: `${c.entity} price` })),
  claims: SIX,
};
const input = (over = {}) => ({
  userMessage: 'Compare prices',
  answer: ANSWER,
  sources: SOURCES,
  asOf: '2026-11-11',
  firstTurn: true,
  profile: [],
  ...over,
});

describe('extraction', () => {
  // S5-T1
  it('stores all six prices character for character', async () => {
    const model = new MockModel({ writeback: { record: RECORD } });
    const result = await runWriteback(model, 'prompt', input());
    expect(result.record!.claims.map((c) => c.value)).toEqual([
      '$19/month',
      '$25 per month',
      '$19.00/mo',
      '$20 per seat/month',
      '$1,449',
      '€3.79 – €4.51/month',
    ]);
    for (const claim of result.record!.claims) expect(ANSWER).toContain(claim.value);

    // And through the database, unchanged.
    const store = new Store(':memory:');
    const user = store.getOrCreateUser('demo', TZ, NOW);
    const session = store.createSession(user.userId, NOW);
    store.addTurn(
      { turnId: 't1', sessionId: session.sessionId, userId: user.userId, userMessage: 'q', assistantMessage: ANSWER, createdAt: NOW, userTimezone: TZ },
      SOURCES,
    );
    store.setAnswerRecord({ turnId: 't1', ...result.record!, createdAt: NOW.toISOString() });
    expect(store.getAnswerRecord('t1')!.claims.map((c) => c.value)).toEqual(SIX.map((c) => c.value));
    expect(store.getAnswerRecord('t1')!.claims[0]).toEqual({
      entity: 'Neon',
      attribute: 'Launch price',
      value: '$19/month',
      asOf: '2026-11-11',
      sourceN: 1,
    });
  });

  it('drops a value the model altered, however slightly', () => {
    const altered = buildRecord(
      {
        topic: 'prices',
        entities: [],
        claims: [
          { entity: 'Neon', attribute: 'price', value: '$19 / month', source_n: 1 }, // spacing changed
          { entity: 'Legion 5i', attribute: 'price', value: '$1449', source_n: 2 }, // separator dropped
          { entity: 'Supabase', attribute: 'price', value: '$25 per month', source_n: 2 }, // exact
          { entity: 'Made up', attribute: 'price', value: '$99', source_n: 1 }, // not in the answer
        ],
      },
      { answer: ANSWER, sources: SOURCES, asOf: '2026-11-11' },
    );
    expect(altered!.claims.map((c) => c.value)).toEqual(['$25 per month']);
    expect(altered!.entities.map((e) => e.name)).toEqual(['Supabase']);
  });

  // S5-T2
  it('validates the output and points every claim at a stored source', async () => {
    const withBadSource = { ...RECORD, claims: [...SIX.slice(0, 5), { ...SIX[5]!, source_n: 9 }] };
    const result = await runWriteback(new MockModel({ writeback: { record: withBadSource } }), 'prompt', input());
    const record = result.record!;
    expect(record.topic).toBe('hosting and tools prices');
    expect(record.entities).toHaveLength(6);
    const stored = new Set(SOURCES.map((s) => s.n));
    // A citation number that is not among the turn's sources is not kept.
    expect(record.claims.map((c) => c.sourceN)).toEqual([1, 2, 3, 1, 2, null]);
    for (const claim of record.claims) {
      if (claim.sourceN !== null) expect(stored.has(claim.sourceN)).toBe(true);
      expect(record.entities.some((e) => e.name === claim.entity)).toBe(true);
      expect(claim.asOf).toBe('2026-11-11');
    }

    // Output that does not fit the schema leaves no record, and no error.
    for (const writeback of [{ chunks: ['{"title": 5}'] }, { chunks: ['not json'] }, { record: { topic: 'x' } }]) {
      const bad = await runWriteback(new MockModel({ writeback }), 'prompt', input());
      expect(bad.record).toBeUndefined();
      expect(bad.title).toBe('Compare prices'); // falls back to the message
    }
    expect(buildRecord({ topic: 'chat', entities: [], claims: [] }, { answer: ANSWER, sources: [], asOf: 'x' })).toBeUndefined();
  });

  it('asks only for the parts a turn needs, and makes no call when it needs none', async () => {
    expect(writebackParts(input({ firstTurn: false, sources: [], answer: 'Hello!' }))).toEqual({
      title: false,
      record: false,
      profile: false,
      summary: false,
    });
    const model = new MockModel();
    expect(await runWriteback(model, 'prompt', input({ firstTurn: false, sources: [], answer: 'Hello!' }))).toEqual({});
    expect(model.requests).toHaveLength(0);

    expect(writebackParts(input({ userMessage: 'Keep answers short please', sources: [], answer: 'OK.' })).profile).toBe(true);
    await runWriteback(model, 'prompt', input({ firstTurn: false }));
    const sent = (model.requests[0]!.messages[0] as { content: string }).content;
    expect(sent).toContain('Parts wanted: record. Set the others to null.');
    expect(sent).toContain('Sources cited by number: [1] Source 1; [2] Source 2; [3] Source 3');
    expect(sent).not.toContain('Current profile');
  });
});

describe('write-back through the chat endpoint', () => {
  const searching = (writeback: object, fast = {}) =>
    new MockModel({
      respond: (_r, n) => (n === 0 ? { searches: [['prices']] } : { chunks: [ANSWER] }),
      writeback,
      fast,
    });
  const search = () =>
    new MockSearch({
      results: () => SOURCES.map((s) => ({ title: s.title, url: s.url, content: 'Pricing page.' })),
    });

  // S5-T3
  it('starts after the last token and is not counted in turn latency', async () => {
    const model = searching({ record: RECORD }, { chunks: ['Price comparison'], delayMs: 300 });
    const { chat, signIn, store } = setup(model, fixedClock(NOW), search());
    const user = await signIn('demo');

    let recordAtDone: AnswerRecord | undefined;
    const events = await readEvents(await chat({ user_id: user.user_id, message: 'Compare prices' }), (e) => {
      if (e.event === 'done') recordAtDone = store.getAnswerRecord(e.data.turn_id);
    });
    const done = events.find((e) => e.event === 'done')!;
    const title = events.find((e) => e.event === 'title')!;
    const lastToken = events.filter((e) => e.event === 'token').at(-1)!;

    // The reply was complete before any record existed, and the 300 ms call is not in its latency.
    expect(recordAtDone).toBeUndefined();
    expect(done.data.total_ms).toBeLessThan(200);
    expect(title.atMs - lastToken.atMs).toBeGreaterThanOrEqual(250);

    const steps = store.listMetrics(done.data.turn_id);
    const writeBack = steps.find((m) => m.step === 'write_back')!;
    const lastRound = steps.filter((m) => m.step === 'model_round').at(-1)!;
    expect(writeBack.durationMs).toBeGreaterThanOrEqual(280);
    expect(writeBack.startedMs).toBeGreaterThanOrEqual(Math.floor(lastRound.startedMs + lastRound.durationMs) - 2);

    // Afterwards: the record, built from the turn's own sources.
    const record = store.getAnswerRecord(done.data.turn_id)!;
    expect(record.claims).toHaveLength(6);
    expect(record.claims.every((c) => c.asOf === '2026-11-11')).toBe(true);
    expect(store.getSession(user.user_id, done.data.session_id)!.title).toBe('Price comparison');
  });

  // S5-T4
  it('still stores the turn when extraction fails, and shows the user no error', async () => {
    const model = searching({ chunks: [], failWith: new Error('fast model is down') });
    const { chat, signIn, store } = setup(model, fixedClock(NOW), search());
    const user = await signIn('demo');

    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(' '));
    let events;
    try {
      events = await readEvents(await chat({ user_id: user.user_id, message: 'Compare prices' }));
    } finally {
      console.error = original;
    }

    expect(events.map((e) => e.event)).toEqual(['search', 'sources', 'token', 'done', 'title']);
    expect(events.some((e) => e.event === 'error')).toBe(false);
    const done = events.find((e) => e.event === 'done')!.data;
    const turns = store.listTurns(user.user_id, done.session_id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistantMessage).toBe(ANSWER);
    expect(store.listSources(done.turn_id)).toHaveLength(3);
    expect(store.getAnswerRecord(done.turn_id)).toBeUndefined();
    expect(logged.join('\n')).toContain('write-back failed: fast model is down');
    // The chat still gets a title, from the message.
    expect(events.at(-1)!.data.title).toBe('Compare prices');
  });
});

describe('re-check', () => {
  const crm = () => {
    const store = new Store(':memory:');
    const { userId } = seedDemo(store);
    return { store, userId, record: store.getAnswerRecord('seed-crm')! };
  };
  // Today's pages: four prices as stored, Pipedrive up from $39 to $49.
  const NOW_PRICES: Record<string, string> = {
    HubSpot: 'Sales Hub Starter costs $20 per seat per month.',
    Pipedrive: 'The Growth plan is now $49 per seat per month, billed annually.',
    Zoho: 'Zoho CRM Professional: $23 per user per month.',
    Salesforce: 'Starter Suite is $25 per user per month.',
    Close: 'Close Growth: $99 per seat per month.',
  };
  const pages = () =>
    new MockSearch({
      results: (q) => {
        const name = Object.keys(NOW_PRICES).find((k) => q.includes(k))!;
        return [{ title: `${name} pricing`, url: `https://example.com/${name.toLowerCase()}`, content: NOW_PRICES[name]! }];
      },
    });

  // S5-T5
  it('issues one query per stored entity, in one round', async () => {
    const { record } = crm();
    const plan = planRecheck([record], '2026');
    expect(plan.items.map((i) => i.query)).toEqual([
      'HubSpot Sales Hub Starter price per seat 2026',
      'Pipedrive Growth plan price per seat 2026',
      'Zoho CRM Professional price per user 2026',
      'Salesforce Starter Suite price per user 2026',
      'Close CRM Growth plan price per seat 2026',
    ]);
    expect(plan.skipped).toEqual([]);

    const search = new MockSearch({ delayMs: 200 });
    const metrics = new MemoryMetrics();
    const t0 = performance.now();
    await runRecheck(plan, [], TZ, { search, metrics, turnId: 't', registry: new SourceRegistry() });
    expect(performance.now() - t0).toBeLessThan(450); // five searches of 200 ms, at the same time
    expect(search.queries).toHaveLength(5);
    expect(metrics.metrics.filter((m) => m.step === 'search')).toHaveLength(5);

    // More entities than one round takes: the rest are named, not silently dropped.
    const many = planRecheck([{ ...record, entities: [...record.entities, { name: 'Attio', query: 'Attio price' }, { name: 'Copper', query: 'Copper price' }] }], '2026');
    expect(many.items).toHaveLength(6);
    expect(many.skipped).toEqual(['Copper']);
  });

  // S5-T5 and S5-T6, through the chat endpoint. A mock model cannot compare
  // prices, so what is checked is everything the real model is handed: one
  // search per entity before it is called, each value then, whether it still
  // appears now, and the page that carries the new value. The live answer is
  // recorded in docs/PLAN.md (evals D1 to D5).
  it('hands the model each old value, whether it still appears, and the new one', async () => {
    const model = new MockModel({
      chunks: ['Pipedrive changed.'],
      understand: { needs_search: true, topics: ['crm'], when: [1] },
    });
    const search = pages();
    const app = setup(model, fixedClock(NOW), search);
    seedDemo(app.store);
    const user = await app.signIn('demo', TZ);
    const events = await readEvents(
      await app.chat({
        user_id: user.user_id,
        message:
          'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
      }),
    );

    // One round, five queries, made by code before the model's first step.
    expect(events.map((e) => e.event)).toEqual(['recall', 'search', 'sources', 'token', 'done', 'title']);
    expect(events[1]!.data.queries).toHaveLength(5);
    expect(search.queries).toHaveLength(5);
    expect(events[2]!.data.sources.map((s: any) => s.n)).toEqual([1, 2, 3, 4, 5]);
    const main = model.requests.filter((r: StreamRequest) => r.model === 'main');
    expect(main).toHaveLength(1);
    expect(main[0]!.toolChoice).toBe('auto');

    const system = main[0]!.system;
    const recheck = system.slice(system.indexOf('<recheck>'));
    expect(recheck).toContain('what you said on Monday 9 November 2026');
    // Old value and whether it is still there, per tool: only Pipedrive's is gone.
    expect(recheck).toContain('| HubSpot Sales Hub | Starter price per seat per month | $20 | ok | yes |');
    expect(recheck).toContain('| Pipedrive | Growth price per seat per month | $39 | ok | no |');
    expect(recheck).toContain('| Zoho CRM | Professional price per seat per month | $23 | ok | yes |');
    expect(recheck).toContain('| Salesforce | Starter Suite price per seat per month | $25 | ok | yes |');
    expect(recheck).toContain('| Close | Growth price per seat per month | $99 | ok | yes |');
    // The new value, in the numbered result for Pipedrive.
    expect(recheck).toMatch(/<result n="2" url="https:\/\/example\.com\/pipedrive"[^>]*>\nThe Growth plan is now \$49 per seat per month/);
    // The sources of the re-check are stored with the turn, so its citations resolve.
    const done = events.find((e) => e.event === 'done')!.data;
    expect(app.store.listSources(done.turn_id)).toHaveLength(5);
    // One search round is used up; two are left for the model.
    expect(recheck.trimEnd().endsWith('</recheck>')).toBe(true);
  });

  it('reports a failed search as not checked (G3)', async () => {
    const { record } = crm();
    const search = new MockSearch({ failing: (q) => q.includes('Zoho') });
    const checked = await runRecheck(planRecheck([record], '2026'), [], TZ, {
      search,
      metrics: new MemoryMetrics(),
      turnId: 't',
      registry: new SourceRegistry(),
    });
    expect(checked.block).toContain('| Zoho CRM | Professional price per seat per month | $23 | failed | not checked |');
    expect(checked.block).toContain('<query text="Zoho CRM Professional price per user 2026" status="failed">');
  });

  it('does not mistake $199 for $19', () => {
    const claim = { entity: 'Neon', attribute: 'price', value: '$19/month', asOf: '2026-11-03', sourceN: 1 };
    const page = (content: string) => ({ query: 'q', status: 'ok' as const, results: [{ n: 1, url: 'u', title: 't', content }] });
    expect(stillStated(claim, page('Launch is $19 per month'))).toBe('yes');
    expect(stillStated(claim, page('Scale is $199 per month'))).toBe('no');
    expect(stillStated(claim, page('Launch is $24 per month'))).toBe('no');
    expect(stillStated(claim, undefined)).toBe('not checked');
    const version = { ...claim, value: 'v26.13.0' };
    expect(stillStated(version, page('Latest LTS: V26.13.0'))).toBe('yes');
  });
});

describe('user profile', () => {
  // S5-T7
  it('keeps a preference said in one chat and shows it to the model in another', async () => {
    const model = new MockModel({ writeback: { profile: ['Wants short answers'] } });
    const { chat, signIn, store } = setup(model, fixedClock(NOW));
    const user = await signIn('asha');

    // Session A
    const a = await readEvents(await chat({ user_id: user.user_id, message: 'Keep answers short from now on.' }));
    const sessionA = a.find((e) => e.event === 'done')!.data.session_id;
    expect(store.getUser(user.user_id)!.profile).toEqual(['Wants short answers']);
    // The profile call was given the message and the profile so far, not the answer.
    const filed = model.requests.find((r) => r.label === 'writeback')!;
    const sent = (filed.messages[0] as { content: string }).content;
    expect(sent).toContain('Parts wanted: title, profile.');
    expect(sent).toContain('Current profile: []');
    expect(sent).not.toContain("Assistant's answer");

    // Session B: a new chat, the same user.
    const b = await readEvents(await chat({ user_id: user.user_id, message: 'Compare three password managers.' }));
    expect(b.find((e) => e.event === 'done')!.data.session_id).not.toBe(sessionA);
    const system = model.requests.filter((r) => r.model === 'main').at(-1)!.system;
    expect(system).toMatch(/<user_profile>\n[^\n]+do what it says\.\n- Wants short answers\n<\/user_profile>/);
    // After the fixed text, before the date: the order that keeps the prompt cacheable.
    expect(system.startsWith('You are a test.\n\n<user_profile>')).toBe(true);
    expect(system.indexOf('<user_profile>')).toBeLessThan(system.indexOf('<context>'));

    // Another user sees none of it.
    const other = await signIn('ben');
    await readEvents(await chat({ user_id: other.user_id, message: 'Compare three password managers.' }));
    expect(model.requests.filter((r) => r.model === 'main').at(-1)!.system).not.toContain('<user_profile>');
  });

  it('keeps the profile small and leaves it alone when nothing was said about it', async () => {
    expect(cleanProfile(['  Wants short answers ', 'wants short answers', '', 7, 'x'.repeat(400)])).toEqual([
      'Wants short answers',
      'x'.repeat(140),
    ]);
    expect(cleanProfile(Array.from({ length: 20 }, (_, i) => `item ${i}`))).toHaveLength(8);
    expect(cleanProfile('not a list')).toBeUndefined();

    // A message with no profile phrase: the profile part is not asked for and not written.
    const model = new MockModel({ writeback: { profile: ['Injected by a web page'] } });
    const { chat, signIn, store } = setup(model, fixedClock(NOW));
    const user = await signIn('asha');
    await readEvents(await chat({ user_id: user.user_id, message: 'Compare three password managers.' }));
    expect(store.getUser(user.user_id)!.profile).toEqual([]);

    // The seeded user starts with the preference from the 9 November turn.
    const seeded = new Store(':memory:');
    expect(seeded.getUser(seedDemo(seeded).userId)!.profile).toEqual(SEED_PROFILE);
  });
});

describe('session summary', () => {
  it('folds a turn into the summary once it leaves the 5-turn history', async () => {
    const model = new MockModel({ chunks: ['ok'], writeback: { summary: 'They chose Postgres over MySQL.' } });
    const { chat, signIn, store } = setup(model, fixedClock(NOW));
    const user = await signIn('demo');
    let sessionId: string | undefined;
    const send = async (message: string) => {
      const events = await readEvents(await chat({ user_id: user.user_id, session_id: sessionId, message }));
      sessionId = events.find((e) => e.event === 'done')!.data.session_id;
    };

    for (let i = 1; i <= 5; i++) await send(`message ${i}`);
    expect(store.getSession(user.user_id, sessionId!)!.summary).toBeNull();
    expect(model.requests.filter((r) => r.label === 'writeback')).toHaveLength(1); // the title only

    // The sixth turn pushes the first out of the window: it is summarised after the reply.
    await send('message 6');
    const session = store.getSession(user.user_id, sessionId!)!;
    expect(session.summary).toBe('They chose Postgres over MySQL.');
    expect(session.summaryTurns).toBe(1);
    const filed = model.requests.filter((r) => r.label === 'writeback').at(-1)!;
    const sent = (filed.messages[0] as { content: string }).content;
    expect(sent).toContain('Parts wanted: summary.');
    expect(sent).toContain('Summary so far: (none yet)');
    expect(sent).toContain('Turn to fold in:\nUser: message 1');

    // The next request carries the summary and the last five turns.
    await send('message 7');
    const main = model.requests.filter((r) => r.model === 'main').at(-1)!;
    expect(main.system).toContain('<earlier_in_this_chat>\nThey chose Postgres over MySQL.\n</earlier_in_this_chat>');
    expect(main.messages.flatMap((m) => (m.role === 'user' ? [m.content] : []))).toEqual([
      'message 2',
      'message 3',
      'message 4',
      'message 5',
      'message 6',
      'message 7',
    ]);
    expect(store.getSession(user.user_id, sessionId!)!.summaryTurns).toBe(2);
  });

  it('adds the summary columns to a database made before they existed', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'minimi-'));
    const path = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(path);
      old.exec(
        `CREATE TABLE sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         INSERT INTO sessions VALUES ('s1', 'u1', 'Old chat', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');`,
      );
      old.close();
      const store = new Store(path);
      const session = store.getSession('u1', 's1')!;
      expect(session.title).toBe('Old chat');
      expect(session.summary).toBeNull();
      expect(session.summaryTurns).toBe(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
