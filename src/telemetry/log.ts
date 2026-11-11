// Logging. One line per finished turn with its step timings, and one line per
// failure. API keys must never reach a log, so every line passes through
// redact() first, in case a provider echoes a key back in an error.
import type { Metric } from './timed.ts';

const secrets: string[] = [];

/** Call once at startup with the configured keys. */
export function registerSecrets(values: (string | undefined)[]): void {
  for (const value of values) {
    if (value && value.length >= 6 && !secrets.includes(value)) secrets.push(value);
  }
}

export function redact(text: string): string {
  let clean = text;
  for (const secret of secrets) clean = clean.split(secret).join('[redacted]');
  return clean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function logInfo(line: string): void {
  console.log(redact(line));
}

/** One line for a finished turn: its id and how long each step took. Never the message or the answer. */
export function turnLine(turnId: string, ttftMs: number | undefined, totalMs: number, metrics: Metric[]): string {
  const steps = new Map<string, { n: number; ms: number }>();
  for (const m of metrics) {
    if (m.step === 'first_token') continue;
    const step = steps.get(m.step) ?? { n: 0, ms: 0 };
    step.n += 1;
    // Searches run at the same time, so the slowest one is what the turn waited for.
    step.ms = m.step === 'search' ? Math.max(step.ms, m.durationMs) : step.ms + m.durationMs;
    steps.set(m.step, step);
  }
  const parts = [...steps].map(([name, s]) => `${name}${s.n > 1 ? ` x${s.n}` : ''} ${Math.round(s.ms)}ms`);
  const first = ttftMs === undefined ? '-' : `${Math.round(ttftMs)}ms`;
  return `[turn ${turnId.slice(0, 8)}] ok first_token=${first} total=${Math.round(totalMs)}ms | ${parts.join(' | ')}`;
}

export function logError(context: string, err: unknown): void {
  console.error(redact(`${context}: ${messageOf(err)}`).slice(0, 1000));
}

/** What to tell the user when the model call fails. Never the provider's own text. */
export function userMessageFor(err: unknown): string {
  const text = messageOf(err);
  if (/quota|rate.?limit|resource_exhausted|\b429\b|too many requests/i.test(text)) {
    return "The model's request limit has been reached. Wait a little and try again, or check the quota of your Gemini key.";
  }
  if (/high demand|overloaded|unavailable|\b503\b|try again later/i.test(text)) {
    return 'The model is busy right now. Please try again in a moment.';
  }
  if (/sent nothing within|timed? ?out|timeout|aborted/i.test(text)) {
    return 'The model took too long to answer. Please try again.';
  }
  if (/api key|permission|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) {
    return 'The model rejected the API key. Check GOOGLE_GENERATIVE_AI_API_KEY in .env.';
  }
  return 'The model could not answer. Please try again.';
}
