import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASES } from '../evals/cases.ts';
import { check, runCase } from '../evals/runner.ts';
import { seedDemo } from '../evals/seed.ts';
import { MockModel } from '../src/llm/mock.ts';
import type { StreamRequest, ToolResultsMessage } from '../src/llm/provider.ts';
import { MockSearch } from '../src/search/mock.ts';
import { logError, redact, registerSecrets, turnLine, userMessageFor } from '../src/telemetry/log.ts';
import { fixedClock } from '../src/temporal/clock.ts';
import { readEvents, setup } from './helpers.ts';

const NOW = new Date('2026-11-11T10:00:00+05:30');
const root = join(import.meta.dirname, '..');
const prompts = { systemPrompt: 'System.', writebackPrompt: 'File.', understandPrompt: 'Understand.' };
const toolOutputs = (request: StreamRequest) =>
  request.messages.filter((m): m is ToolResultsMessage => m.role === 'tool').flatMap((m) => m.results.map((r) => r.output));

describe('search provider down', () => {
  const down = () => new MockSearch({ failing: () => true });

  // S6-T2
  it('answers a re-check from memory and is told it could not search', async () => {
    const model = new MockModel({ chunks: ['Then: Neon $19/month. I could not check current prices.'] });
    const search = down();
    const app = setup(model, fixedClock(NOW), search);
    seedDemo(app.store);
    const user = await app.signIn('demo');
    const events = await readEvents(
      await app.chat({
        user_id: user.user_id,
        message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      }),
    );

    // The turn completes, with no error shown, and the failures are reported to the page.
    expect(events.map((e) => e.event)).toEqual(['recall', 'search', 'sources', 'token', 'done', 'title']);
    expect(events[2]!.data.sources).toEqual([]);
    expect(events[2]!.data.failed).toHaveLength(3);

    // The model has the stored answer and is told, per item, that nothing could be checked.
    const system = model.requests.find((r) => r.model === 'main')!.system;
    expect(system).toContain('<record date="Tuesday 3 November 2026" time="11:00" chat="Postgres hosting">');
    expect(system).toContain('| Neon | Launch plan price | $19/month | failed | not checked |');
    expect(system).toContain('| Supabase | Pro plan price | $25/month | failed | not checked |');
    expect(system.match(/status="failed"/g)).toHaveLength(3);
    expect(system).toContain('tell the user what you could not check');

    const done = events.find((e) => e.event === 'done')!.data;
    expect(app.store.listTurns(user.user_id, done.session_id)).toHaveLength(1);
    expect(app.store.listMetrics(done.turn_id).filter((m) => m.step === 'search').map((m) => m.status)).toEqual([
      'error',
      'error',
      'error',
    ]);
  });

  it('stops searching after a round in which every search failed', async () => {
    // A model that would keep searching for as long as it is allowed to.
    const model = new MockModel({
      respond: (_r, n) => ({ searches: [[`attempt ${n} a`, `attempt ${n} b`]], chunks: ['I could not search the web just now.'] }),
    });
    const search = down();
    const { chat, signIn } = setup(model, fixedClock(NOW), search);
    const user = await signIn('demo');
    const events = await readEvents(await chat({ user_id: user.user_id, message: 'What is the latest Node.js version?' }));

    expect(search.queries).toEqual(['attempt 0 a', 'attempt 0 b']); // one round, not three
    const main = model.requests.filter((r) => r.model === 'main');
    expect(main.map((r) => r.toolChoice)).toEqual(['auto', 'none']);
    expect(toolOutputs(main[1]!)[0]).toContain('Web search is not working right now, so do not search again.');
    expect(events.filter((e) => e.event === 'token').map((e) => e.data.text).join('')).toBe('I could not search the web just now.');
    expect(events.some((e) => e.event === 'error')).toBe(false);
  });

  it('handles a search that returns nothing', async () => {
    const model = new MockModel({ respond: (_r, n) => (n === 0 ? { searches: [['obscure thing']] } : { chunks: ['I found nothing on that.'] }) });
    const { chat, signIn } = setup(model, fixedClock(NOW), new MockSearch({ results: () => [] }));
    const user = await signIn('demo');
    const events = await readEvents(await chat({ user_id: user.user_id, message: 'What is the latest version of obscure thing?' }));
    expect(events.at(-2)!.event).toBe('done');
    expect(toolOutputs(model.requests.filter((r) => r.model === 'main')[1]!)[0]).toContain('No new results.');
  });
});

describe('model errors', () => {
  const failing = (error: Error, chunks = ['Half an ans']) => new MockModel({ chunks, failWith: error });

  // S6-T3
  it('shows a clear error when the model fails mid-stream and stores no half turn', async () => {
    const { chat, signIn, store, app } = setup(failing(new Error('socket hang up')), fixedClock(NOW));
    const user = await signIn('demo');
    const events = await readEvents(await chat({ user_id: user.user_id, message: 'Tell me something long.' }));

    expect(events.map((e) => e.event)).toEqual(['token', 'error']);
    expect(events[1]!.data.message).toBe('The model could not answer. Please try again.');
    // Nothing of the half answer is kept: no session, no turn, no sources, no record.
    expect(store.listSessions(user.user_id)).toEqual([]);
    expect(store.latestTurns(user.user_id, 10)).toEqual([]);
    const sessions = (await (await app.request(`/api/sessions?user_id=${user.user_id}`)).json()) as any;
    expect(sessions.sessions).toEqual([]);

    // In an existing chat the earlier turns stay and the failed one is not added.
    const ok = setup(new MockModel({ respond: (_r, n) => (n === 0 ? { chunks: ['Fine.'] } : { chunks: ['Half'], failWith: new Error('boom') }) }), fixedClock(NOW));
    const u = await ok.signIn('demo');
    const first = await readEvents(await ok.chat({ user_id: u.user_id, message: 'one' }));
    const sessionId = first.find((e) => e.event === 'done')!.data.session_id;
    const second = await readEvents(await ok.chat({ user_id: u.user_id, session_id: sessionId, message: 'two' }));
    expect(second.at(-1)!.event).toBe('error');
    expect(ok.store.listTurns(u.user_id, sessionId).map((t) => t.userMessage)).toEqual(['one']);
  });

  it('tells the user what kind of failure it was, never the provider text', async () => {
    const cases: [Error, RegExp][] = [
      [new Error('You exceeded your current quota, please check your plan'), /request limit has been reached/],
      [new Error('429 Too Many Requests'), /request limit has been reached/],
      [new Error('This model is currently experiencing high demand. Please try again later.'), /busy right now/],
      [new Error('model gemini-x sent nothing within 20 s'), /took too long/],
      [new Error('API key not valid. Please pass a valid API key.'), /rejected the API key/],
      [new Error('internal: secret-detail-xyz'), /could not answer/],
    ];
    for (const [error, expected] of cases) {
      expect(userMessageFor(error)).toMatch(expected);
      const { chat, signIn } = setup(failing(error, []), fixedClock(NOW));
      const user = await signIn('demo');
      const events = await readEvents(await chat({ user_id: user.user_id, message: 'hello there' }));
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('error');
      expect(events[0]!.data.message).toMatch(expected);
      expect(events[0]!.data.message).not.toContain('secret-detail');
    }
  });

  it('answers a broken request with JSON, not a crash', async () => {
    const { app } = setup(new MockModel());
    const bad = await app.request('/api/chat', { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'message is required' });
    expect((await app.request('/api/users', { method: 'POST', body: '{' })).status).toBe(400);
  });
});

describe('API keys stay out of logs and the database', () => {
  it('logs one line per turn with step timings and nothing of the conversation', () => {
    const step = (name: string, durationMs: number) => ({ turnId: 't', step: name, startedMs: 0, durationMs, status: 'ok' as const });
    const line = turnLine('abcdef12-3456', 3658.2, 4290.4, [
      step('build_context', 0.2),
      step('recall', 1.6),
      step('search', 725),
      step('search', 610),
      step('first_token', 3658),
      step('model_round', 3466),
      step('store_turn', 13),
    ]);
    expect(line).toBe(
      '[turn abcdef12] ok first_token=3658ms total=4290ms | build_context 0ms | recall 2ms | search x2 725ms | model_round 3466ms | store_turn 13ms',
    );
  });

  it('redacts a key that a provider echoes back in an error', () => {
    registerSecrets(['tvly-FAKE-KEY-0123456789', undefined, 'abc']);
    expect(redact('401 for key tvly-FAKE-KEY-0123456789 (tvly-FAKE-KEY-0123456789)')).toBe('401 for key [redacted] ([redacted])');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(' '));
    try {
      logError('search failed', new Error('bad key tvly-FAKE-KEY-0123456789'));
    } finally {
      console.error = original;
    }
    expect(logged).toEqual(['search failed: bad key [redacted]']);
  });

  // S6-T4: the real server, started with made-up keys, asked a question. Whether
  // or not the machine is online the model call fails; nothing it logs or
  // stores may contain either key.
  it('writes no key to stdout, stderr or the database after a run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minimi-keys-'));
    const google = 'AIzaFAKE-google-key-for-the-key-leak-test-000';
    const tavily = 'tvly-FAKE-tavily-key-for-the-key-leak-test-000';
    const port = 3900 + Math.floor(Math.random() * 90);
    const child = spawn(process.execPath, ['--import', 'tsx', join('src', 'server', 'main.ts')], {
      cwd: root,
      env: {
        ...process.env,
        ENV_FILE: 'no-such-file.env',
        GOOGLE_GENERATIVE_AI_API_KEY: google,
        TAVILY_API_KEY: tavily,
        DB_PATH: join(dir, 'leak.db'),
        PORT: String(port),
        CLOCK_OVERRIDE: '',
      },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 60; i++) {
        if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const post = (path: string, body: unknown) =>
        fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const user = (await (await post('/api/users', { name: 'key check', timezone: 'UTC' })).json()) as { user_id: string };
      const reply = await (await post('/api/chat', { user_id: user.user_id, message: 'What did I ask you yesterday about Postgres pricing?' })).text();
      expect(reply).toContain('event: error');
      expect(reply).not.toContain(google);
      expect(reply).not.toContain(tavily);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }

    expect(output).toContain('minimi-agent is running');
    expect(output).toContain('turn failed'); // the failure was logged...
    for (const key of [google, tavily]) expect(output).not.toContain(key); // ...without a key
    try {
      const files = readdirSync(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const bytes = readFileSync(join(dir, file)).toString('latin1');
        for (const key of [google, tavily]) expect(bytes).not.toContain(key);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('eval runner', () => {
  it('has a case for every question in evals/questions.md', () => {
    const text = readFileSync(join(root, 'evals', 'questions.md'), 'utf8');
    const inDoc = [...text.matchAll(/^\| ([A-G]\d) \|/gm)].map((m) => m[1]!);
    expect(inDoc.length).toBeGreaterThan(25);
    expect(CASES.map((c) => c.id).sort()).toEqual([...inDoc].sort());
  });

  // S6-T1, the part that needs no network: the runner seeds, fixes the clock and
  // checks. With a mock model the wording checks cannot pass, so this looks at
  // what code decides: which turns are recalled, and how many searches a re-check makes.
  it('seeds, fixes the clock and gets recall and re-check right for every dated case', async () => {
    const deps = { model: new MockModel({ chunks: ['A mock answer.'] }), search: new MockSearch(), prompts };
    const expected: Record<string, { recalled: string[]; firstRound: number }> = {
      C1: { recalled: ['seed-postgres', 'seed-test-runners'], firstRound: 0 },
      C2: { recalled: ['seed-crm', 'seed-preference'], firstRound: 0 },
      C3: { recalled: ['seed-postgres'], firstRound: 0 },
      C4: { recalled: ['seed-laptops'], firstRound: 0 },
      C5: { recalled: [], firstRound: 0 },
      C6: { recalled: ['seed-postgres', 'seed-test-runners', 'seed-laptops', 'seed-crm', 'seed-preference'], firstRound: 0 },
      D1: { recalled: ['seed-crm'], firstRound: 5 },
      D2: { recalled: ['seed-postgres', 'seed-test-runners'], firstRound: 6 },
      D3: { recalled: ['seed-postgres'], firstRound: 3 },
      D4: { recalled: ['seed-laptops'], firstRound: 3 },
      E1: { recalled: [], firstRound: 0 },
      E2: { recalled: ['seed-postgres', 'seed-test-runners', 'seed-laptops'], firstRound: 0 },
      E3: { recalled: [], firstRound: 0 },
      E4: { recalled: [], firstRound: 0 },
      G2: { recalled: ['seed-postgres'], firstRound: 3 },
      G3: { recalled: ['seed-crm'], firstRound: 5 },
      G5: { recalled: [], firstRound: 0 },
    };
    for (const [id, want] of Object.entries(expected)) {
      const result = await runCase(CASES.find((c) => c.id === id)!, deps);
      expect(result.last.error, id).toBeUndefined();
      expect([...(result.last.recalled ?? ['memory not consulted'])].sort(), id).toEqual([...want.recalled].sort());
      expect(result.last.rounds[0]?.length ?? 0, id).toBe(want.firstRound);
      expect(result.last.answer, id).toBe('A mock answer.');
    }
    // The search setups of the robustness cases reach the app.
    const g2 = await runCase(CASES.find((c) => c.id === 'G2')!, deps);
    expect(g2.last.failedQueries).toHaveLength(3);
    const g3 = await runCase(CASES.find((c) => c.id === 'G3')!, deps);
    expect(g3.last.failedQueries).toEqual(['Zoho CRM Professional price per user 2026']);
  });

  it('passes and fails cases on the checks', async () => {
    const turn = (over = {}) => ({ message: 'q', answer: 'I have no record for that day. The nearest is 7 November.', rounds: [], failedQueries: [], sources: [], recalled: [], ...over });
    const c5 = CASES.find((c) => c.id === 'C5')!.expect;
    expect(check(c5, turn(), [])).toEqual([]);
    expect(check(c5, turn({ answer: 'You asked about laptops.' }), [])).toHaveLength(2);
    expect(check(c5, turn({ rounds: [['x']] }), [])).toEqual(['searched (1 round(s)) but should not have']);
    expect(check(c5, turn({ recalled: ['seed-laptops'] }), [])[0]).toContain('recalled [seed-laptops], expected []');
    expect(check(c5, turn({ error: 'The model could not answer.' }), [])[0]).toContain('the turn failed');

    const cited = { cited: true, citesHost: ['postgresql.org'], table: true };
    const sources = [{ n: 1, url: 'https://www.postgresql.org/docs/release/', title: 'Release notes' }];
    expect(check(cited, turn({ answer: '| a | b |\n|---|---|\n| PostgreSQL 18 [1] | x |', sources }), [])).toEqual([]);
    expect(check(cited, turn({ answer: 'One. Two. Three. See [2].', sources }), [])).toHaveLength(3);
    expect(check({ maxSentences: 2 }, turn({ answer: 'An index is a lookup structure. It speeds up reads.' }), [])).toEqual([]);
    expect(check({ maxSentences: 2 }, turn({ answer: 'One. Two. Three.' }), [])).toHaveLength(1);
    expect(check({ profile: /long/ }, turn(), ['Wants long detailed answers'])).toEqual([]);
    expect(check({ profile: /long/ }, turn(), ['Wants short answers'])).toHaveLength(1);

    // A whole case through the runner: a model that answers C5 properly passes, one that invents fails.
    const honest = new MockModel({ chunks: ['I have no record for Friday 6 November 2026. Nearest: Saturday 7 November 2026.'] });
    const liar = new MockModel({ chunks: ['On 6 November you asked about laptops.'] });
    const c5case = CASES.find((c) => c.id === 'C5')!;
    expect((await runCase(c5case, { model: honest, search: new MockSearch(), prompts })).passed).toBe(true);
    const failed = await runCase(c5case, { model: liar, search: new MockSearch(), prompts });
    expect(failed.passed).toBe(false);
    expect(failed.failures.length).toBeGreaterThan(0);
  });
});
