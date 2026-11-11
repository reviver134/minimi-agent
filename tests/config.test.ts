import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const root = join(import.meta.dirname, '..');

describe('config', () => {
  it('fills defaults when only the key is set', () => {
    const config = loadConfig({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-key', MODEL_MAIN: '' });
    expect(config.port).toBe(3000);
    expect(config.modelMain).toBe('gemini-3.6-flash');
    expect(config.modelFast).toBe('gemini-3.5-flash-lite');
    expect(config.dbPath).toBe('./data/minimi.db');
  });

  it('names the missing variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY is not set/);
    expect(() => loadConfig({ GOOGLE_GENERATIVE_AI_API_KEY: '   ' })).toThrow(
      /GOOGLE_GENERATIVE_AI_API_KEY is not set/,
    );
  });

  it('rejects a bad PORT and a bad CLOCK_OVERRIDE', () => {
    const key = { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' };
    expect(() => loadConfig({ ...key, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...key, CLOCK_OVERRIDE: 'tomorrow-ish' })).toThrow(/CLOCK_OVERRIDE/);
  });

  // S1-T2
  it('the server exits with a message naming the missing key', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: 'no-such-file.env' };
    delete env.GOOGLE_GENERATIVE_AI_API_KEY;
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', join('src', 'server', 'main.ts')],
      { cwd: root, env, encoding: 'utf8', timeout: 15_000 },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('GOOGLE_GENERATIVE_AI_API_KEY is not set');
  });
});
