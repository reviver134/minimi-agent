// Loads the eval history for the user `demo` into the database: npm run seed
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_USER, seedDemo } from '../evals/seed.ts';
import { Store } from '../src/memory/store.ts';

process.chdir(join(import.meta.dirname, '..'));
const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dbPath = process.env.DB_PATH?.trim() || './data/minimi.db';
const store = new Store(dbPath);
const { added } = seedDemo(store);
store.close();

console.log(
  added > 0
    ? `Added ${added} turns for user "${SEED_USER.name}" to ${dbPath}.`
    : `User "${SEED_USER.name}" already has the seeded history in ${dbPath}; nothing added.`,
);
console.log('To ask the eval questions, set CLOCK_OVERRIDE=2026-11-11T10:00:00+05:30 in .env and sign in as demo.');
