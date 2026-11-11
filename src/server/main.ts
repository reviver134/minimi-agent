// Entry point: load settings, then serve the API and the chat page.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from '../config.ts';
import { GeminiModel } from '../llm/gemini.ts';
import { Store } from '../memory/store.ts';
import { TavilySearch } from '../search/tavily.ts';
import { systemClock } from '../temporal/clock.ts';
import { createApp } from './app.ts';

const root = join(import.meta.dirname, '..', '..');
process.chdir(root);

// ENV_FILE lets tests point at a different (or missing) file.
const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const readPrompt = (name: string) => readFileSync(join('prompts', name), 'utf8').trim();

const app = createApp({
  model: new GeminiModel({
    apiKey: config.googleApiKey,
    modelMain: config.modelMain,
    modelFast: config.modelFast,
    thinkingLevel: config.thinkingLevel,
  }),
  search: new TavilySearch({ apiKey: config.tavilyApiKey }),
  store: new Store(config.dbPath),
  clock: systemClock,
  systemPrompt: readPrompt('system.md'),
  titlePrompt: readPrompt('title.md'),
});

// Local only: there is no login, so the server does not listen on the network.
serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`minimi-agent is running at http://localhost:${info.port}`);
  console.log(`models: main=${config.modelMain} (thinking ${config.thinkingLevel}) fast=${config.modelFast}`);
});
