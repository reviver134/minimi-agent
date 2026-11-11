// The system prompt, in tagged sections. Order matters for prompt caching: the
// fixed text from prompts/system.md comes first and is the same for every
// request; what changes comes last, slowest-changing first: the user's profile
// (rarely), today's date and timezone (once a day), the summary of this chat's
// older turns (every turn of a long chat), then what was looked up for this one
// message: recalled records and re-check results.
// Session history is sent as chat messages, after the system prompt.

export interface PromptContext {
  now: Date;
  timezone: string;
  /** Lasting facts about the user and how they want answers. */
  profile?: string[];
  /** What was said in this chat before the turns sent as history. */
  summary?: string | null;
  /** The <recalled_records> section, when memory was looked up for this message. */
  recalled?: string;
  /** The <recheck> section, when stored claims were searched again for this message. */
  recheck?: string;
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
  const profile = context.profile ?? [];
  return [
    fixed.trim(),
    ...(profile.length > 0 ? ['', '<user_profile>', ...profile.map((p) => `- ${p}`), '</user_profile>'] : []),
    '',
    '<context>',
    `Today is ${localDate(context.now, context.timezone)}.`,
    `The user's timezone is ${context.timezone}.`,
    '</context>',
    ...(context.summary ? ['', '<earlier_in_this_chat>', context.summary, '</earlier_in_this_chat>'] : []),
    ...(context.recalled ? ['', context.recalled] : []),
    ...(context.recheck ? ['', context.recheck] : []),
  ].join('\n');
}
