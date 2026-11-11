// Error logging. API keys must never reach a log, so every message passes
// through redact() first, in case a provider echoes a key back in an error.

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

export function logError(context: string, err: unknown): void {
  console.error(redact(`${context}: ${messageOf(err)}`).slice(0, 1000));
}

/** What to tell the user when the model call fails. Never the provider's own text. */
export function userMessageFor(err: unknown): string {
  const text = messageOf(err);
  if (/quota|rate.?limit|resource_exhausted|\b429\b|too many requests/i.test(text)) {
    return "The model's request limit has been reached. Wait a little and try again, or check the quota of your Gemini key.";
  }
  if (/sent nothing within|timed? ?out|timeout|aborted/i.test(text)) {
    return 'The model took too long to answer. Please try again.';
  }
  if (/api key|permission|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) {
    return 'The model rejected the API key. Check GOOGLE_GENERATIVE_AI_API_KEY in .env.';
  }
  return 'The model could not answer. Please try again.';
}
