// The system prompt, in tagged sections. Order matters for prompt caching: the
// fixed text from prompts/system.md comes first and is the same for every
// request; what changes comes last, slowest-changing first: today's date and
// timezone (once a day), then the records recalled for this one message.
// Session history is sent as chat messages, after the system prompt.

export interface PromptContext {
  now: Date;
  timezone: string;
  /** The <recalled_records> section, when memory was looked up for this message. */
  recalled?: string;
}

/** "Wednesday, 11 November 2026" in the user's timezone. No clock time, so the prompt is stable for a day. */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

export function buildSystemPrompt(fixed: string, context: PromptContext): string {
  return [
    fixed.trim(),
    '',
    '<context>',
    `Today is ${localDate(context.now, context.timezone)}.`,
    `The user's timezone is ${context.timezone}.`,
    '</context>',
    ...(context.recalled ? ['', context.recalled] : []),
  ].join('\n');
}
