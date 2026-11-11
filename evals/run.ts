// The eval runner: npm run evals
//
// Seeds a fresh database for every question, fixes the clock at Wednesday
// 11 November 2026 10:00 (Asia/Kolkata), asks each question of
// evals/questions.md through the real chat endpoint with the real model and
// search, and prints pass or fail and latency. A report with every answer is
// written to evals/results/latest.md.
//
//   npm run evals                          every question, once
//   npm run evals -- --only C1,D3          just these
//   npm run evals -- --latency-runs 3      also time the four latency paths 3 times (median)
//   npm run evals -- --pause 4000          wait between questions (free-tier rate limits)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { GeminiModel } from '../src/llm/gemini.ts';
import { TavilySearch } from '../src/search/tavily.ts';
import { registerSecrets } from '../src/telemetry/log.ts';
import { CASES, LATENCY_TARGETS, RECALL_QUERY_TARGET_MS } from './cases.ts';
import { EVAL_CLOCK, type EvalResult, median, runCase } from './runner.ts';

process.chdir(join(import.meta.dirname, '..'));
const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
registerSecrets([config.googleApiKey, config.tavilyApiKey]);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const only = arg('only')?.split(',').map((s) => s.trim().toUpperCase());
const latencyRuns = Number(arg('latency-runs') ?? 1);
const pauseMs = Number(arg('pause') ?? 1500);
const outPath = arg('out') ?? join('evals', 'results', 'latest.md');

const readPrompt = (name: string) => readFileSync(join('prompts', name), 'utf8').trim();
const deps = {
  model: new GeminiModel({
    apiKey: config.googleApiKey,
    modelMain: config.modelMain,
    modelFast: config.modelFast,
    thinkingLevel: config.thinkingLevel,
  }),
  search: new TavilySearch({ apiKey: config.tavilyApiKey }),
  prompts: {
    systemPrompt: readPrompt('system.md'),
    writebackPrompt: readPrompt('writeback.md'),
    understandPrompt: readPrompt('understand.md'),
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secs = (ms: number | undefined) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);
const isQuota = (r: EvalResult) => /request limit/i.test(r.last.error ?? '');

const cases = CASES.filter((c) => !only || only.includes(c.id));
console.log(`Running ${cases.length} eval(s) with main=${config.modelMain}, fast=${config.modelFast}, clock ${EVAL_CLOCK}\n`);

const results: EvalResult[] = [];
let stopped: string | undefined;
for (const evalCase of cases) {
  const result = await runCase(evalCase, deps);
  results.push(result);
  const mark = result.passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.id.padEnd(3)} first token ${secs(result.last.ttftMs).padStart(7)}  total ${secs(result.last.totalMs).padStart(7)}`);
  for (const failure of result.failures) console.log(`        - ${failure}`);
  if (isQuota(result)) {
    stopped = `Stopped after ${result.id}: the Gemini key's request limit was reached.`;
    console.log(`\n${stopped}`);
    break;
  }
  await sleep(pauseMs);
}

// Latency paths: extra runs of the four cases the targets are set for.
const timings = new Map<string, number[]>();
const recallTimes: number[] = [];
for (const result of results) {
  if (result.last.ttftMs !== undefined) timings.set(result.id, [result.last.ttftMs]);
  if (result.last.recallMs !== undefined) recallTimes.push(result.last.recallMs);
}
if (!stopped && latencyRuns > 1) {
  console.log(`\nTiming the latency paths ${latencyRuns - 1} more time(s)...`);
  for (let run = 1; run < latencyRuns && !stopped; run++) {
    for (const target of LATENCY_TARGETS) {
      const evalCase = CASES.find((c) => c.id === target.case)!;
      const result = await runCase(evalCase, deps);
      if (isQuota(result)) {
        stopped = `Latency runs stopped at ${target.case}: the Gemini key's request limit was reached.`;
        console.log(stopped);
        break;
      }
      if (result.last.ttftMs !== undefined) timings.set(target.case, [...(timings.get(target.case) ?? []), result.last.ttftMs]);
      await sleep(pauseMs);
    }
  }
}

const passed = results.filter((r) => r.passed).length;
console.log(`\n${passed} of ${results.length} passed.`);

// --- report ---
const lines: string[] = [
  '# Eval results',
  '',
  `Run on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Main model \`${config.modelMain}\`, fast model \`${config.modelFast}\`, thinking \`${config.thinkingLevel}\`, clock fixed at ${EVAL_CLOCK}.`,
  '',
  `**${passed} of ${results.length} passed** the checks code can make. "Still to judge" is what a person must confirm by reading the answer below.`,
  ...(stopped ? ['', `**${stopped}** Questions after that were not run.`] : []),
  '',
  '| ID | Result | First token | Total | Failed checks | Still to judge |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.passed ? 'pass' : '**FAIL**'} | ${secs(r.last.ttftMs)} | ${secs(r.last.totalMs)} | ${r.failures.join('; ').replace(/\|/g, '/') || ''} | ${r.judge ?? ''} |`,
  ),
  '',
  '## Latency',
  '',
  `Time to first token${latencyRuns > 1 ? `, median of up to ${latencyRuns} runs` : ', one run'}.`,
  '',
  '| ID | Path | Example | Target | Measured | Runs | Met |',
  '|---|---|---|---|---|---|---|',
  ...LATENCY_TARGETS.map((t) => {
    const runs = timings.get(t.case) ?? [];
    const value = runs.length ? median(runs) : undefined;
    return `| ${t.id} | ${t.path} | ${t.case} | under ${secs(t.targetMs)} | ${secs(value)} | ${runs.map(secs).join(', ') || '-'} | ${value === undefined ? '-' : value <= t.targetMs ? 'yes' : 'no'} |`;
  }),
  `| H5 | Recall query alone | database step | under ${RECALL_QUERY_TARGET_MS} ms | ${recallTimes.length ? `${median(recallTimes)!.toFixed(1)} ms` : '-'} | ${recallTimes.length} | ${recallTimes.length ? (median(recallTimes)! <= RECALL_QUERY_TARGET_MS ? 'yes' : 'no') : '-'} |`,
  '',
  '## Answers',
];
for (const r of results) {
  lines.push('', `### ${r.id}: ${r.passed ? 'pass' : 'FAIL'}`, '');
  for (const failure of r.failures) lines.push(`- Failed: ${failure}`);
  if (r.judge) lines.push(`- Still to judge: ${r.judge}`);
  for (const turn of r.turns) {
    lines.push('', `**Asked:** ${turn.message}`, '');
    if (turn.recalled !== undefined) lines.push(`Recalled: ${turn.recalled.join(', ') || 'nothing'}`, '');
    turn.rounds.forEach((queries, i) => lines.push(`Search round ${i + 1}: ${queries.join(' · ')}`, ''));
    if (turn.failedQueries.length) lines.push(`Failed searches: ${turn.failedQueries.join(' · ')}`, '');
    lines.push(turn.error ? `Error: ${turn.error}` : turn.answer.length > 2500 ? `${turn.answer.slice(0, 2500)}\n\n[answer cut here]` : turn.answer);
  }
}
mkdirSync(join(outPath, '..'), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(`Report written to ${outPath}`);
process.exit(passed === results.length && !stopped ? 0 : 1);
