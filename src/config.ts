// Settings come from the environment and are checked once at startup.
// Key values are held in memory only: never log or store a Config.
import { z } from 'zod';

const required = (name: string) =>
  z.string({ error: `${name} is not set` }).trim().min(1, `${name} is not set`);

const schema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: required('GOOGLE_GENERATIVE_AI_API_KEY'),
  // Used from session 3 (web search); becomes required there.
  TAVILY_API_KEY: z.string().trim().optional(),
  MODEL_MAIN: z.string().trim().min(1).default('gemini-3.8-flash'),
  MODEL_FAST: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
  PORT: z.coerce
    .number({ error: 'PORT must be a number' })
    .int('PORT must be a whole number')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),
  DB_PATH: z.string().trim().min(1).default('./data/minimi.db'),
  CLOCK_OVERRIDE: z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'CLOCK_OVERRIDE must be an ISO time')
    .optional(),
});

export interface Config {
  googleApiKey: string;
  tavilyApiKey: string | undefined;
  modelMain: string;
  modelFast: string;
  port: number;
  dbPath: string;
  clockOverride: string | undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Configuration problem:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Copy .env.example to .env and fill it in.',
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // An empty value in .env ("MODEL_MAIN=") means "not set", so defaults apply.
  const cleaned = Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, env[k]?.trim() ? env[k] : undefined]),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => i.message));
  }
  const v = parsed.data;
  return {
    googleApiKey: v.GOOGLE_GENERATIVE_AI_API_KEY,
    tavilyApiKey: v.TAVILY_API_KEY,
    modelMain: v.MODEL_MAIN,
    modelFast: v.MODEL_FAST,
    port: v.PORT,
    dbPath: v.DB_PATH,
    clockOverride: v.CLOCK_OVERRIDE,
  };
}
