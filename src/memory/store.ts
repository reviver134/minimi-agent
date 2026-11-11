// The SQLite store. Raw turns are the source of truth; every read of sessions
// or turns is scoped by user_id.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Source } from '../agent/webSearch.ts';
import type { Metric, MetricsSink } from '../telemetry/timed.ts';
import { SCHEMA } from './schema.ts';

export interface User {
  userId: string;
  userName: string;
  timezone: string;
}

export interface Session {
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  turnId: string;
  sessionId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  /** UTC, ISO 8601. */
  createdAt: string;
  userTimezone: string;
}

export interface NewTurn {
  turnId: string;
  sessionId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  createdAt: Date;
  userTimezone: string;
}

/** "  Jayant " and "jayant" are the same person. Returns '' for a blank name. */
export function normaliseName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const USER = 'user_id AS userId, user_name AS userName, timezone';
const SESSION =
  'session_id AS sessionId, user_id AS userId, title, created_at AS createdAt, updated_at AS updatedAt';
const TURN =
  'turn_id AS turnId, session_id AS sessionId, user_id AS userId, user_message AS userMessage, ' +
  'assistant_message AS assistantMessage, created_at AS createdAt, user_timezone AS userTimezone';

export class Store implements MetricsSink {
  private readonly db: DatabaseSync;

  /** path is a file, or ':memory:' for tests. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- users ---

  /** Finds the user with this name, or creates one. Keeps their timezone current. */
  getOrCreateUser(name: string, timezone: string, now: Date): User {
    const userName = normaliseName(name);
    if (!userName) throw new Error('user name is empty');
    this.db
      .prepare(
        `INSERT INTO users (user_id, user_name, timezone, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_name) DO UPDATE SET timezone = excluded.timezone`,
      )
      .run(randomUUID(), userName, timezone, now.toISOString());
    return this.db.prepare(`SELECT ${USER} FROM users WHERE user_name = ?`).get(userName) as unknown as User;
  }

  getUser(userId: string): User | undefined {
    return this.db.prepare(`SELECT ${USER} FROM users WHERE user_id = ?`).get(userId) as User | undefined;
  }

  // --- sessions ---

  createSession(userId: string, now: Date): Session {
    const sessionId = randomUUID();
    const at = now.toISOString();
    this.db
      .prepare('INSERT INTO sessions (session_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, userId, at, at);
    return { sessionId, userId, title: null, createdAt: at, updatedAt: at };
  }

  getSession(userId: string, sessionId: string): Session | undefined {
    return this.db
      .prepare(`SELECT ${SESSION} FROM sessions WHERE session_id = ? AND user_id = ?`)
      .get(sessionId, userId) as Session | undefined;
  }

  /** The user's sessions, most recently used first. */
  listSessions(userId: string): Session[] {
    return this.db
      .prepare(`SELECT ${SESSION} FROM sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC`)
      .all(userId) as unknown as Session[];
  }

  setSessionTitle(sessionId: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(title, sessionId);
  }

  // --- turns ---

  /** Stores a finished turn and the sources it was shown, together or not at all. */
  addTurn(turn: NewTurn, sources: Source[] = []): void {
    const at = turn.createdAt.toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO turns (turn_id, session_id, user_id, user_message, assistant_message, created_at, user_timezone)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(turn.turnId, turn.sessionId, turn.userId, turn.userMessage, turn.assistantMessage, at, turn.userTimezone);
      const addSource = this.db.prepare(
        'INSERT INTO sources (turn_id, n, url, title, published_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const s of sources) addSource.run(turn.turnId, s.n, s.url, s.title, s.publishedAt ?? null);
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(at, turn.sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The numbered sources of one turn. */
  listSources(turnId: string): Source[] {
    const rows = this.db
      .prepare('SELECT n, url, title, published_at AS publishedAt FROM sources WHERE turn_id = ? ORDER BY n')
      .all(turnId) as unknown as (Omit<Source, 'publishedAt'> & { publishedAt: string | null })[];
    return rows.map(({ publishedAt, ...rest }) => ({ ...rest, ...(publishedAt ? { publishedAt } : {}) }));
  }

  /** A session's turns, oldest first. With limit, only the most recent ones. */
  listTurns(userId: string, sessionId: string, limit?: number): Turn[] {
    if (limit === undefined) {
      return this.db
        .prepare(`SELECT ${TURN} FROM turns WHERE user_id = ? AND session_id = ? ORDER BY created_at, rowid`)
        .all(userId, sessionId) as unknown as Turn[];
    }
    const newestFirst = this.db
      .prepare(
        `SELECT ${TURN} FROM turns WHERE user_id = ? AND session_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(userId, sessionId, limit) as unknown as Turn[];
    return newestFirst.reverse();
  }

  // --- metrics ---

  record(metric: Metric): void {
    this.db
      .prepare(
        `INSERT INTO turn_metrics (turn_id, step, started_ms, duration_ms, status, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.turnId,
        metric.step,
        Math.round(metric.startedMs),
        metric.durationMs,
        metric.status,
        metric.tokensIn ?? null,
        metric.tokensOut ?? null,
      );
  }

  listMetrics(turnId: string): Metric[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id AS turnId, step, started_ms AS startedMs, duration_ms AS durationMs, status,
                tokens_in AS tokensIn, tokens_out AS tokensOut
         FROM turn_metrics WHERE turn_id = ? ORDER BY rowid`,
      )
      .all(turnId) as unknown as (Omit<Metric, 'tokensIn' | 'tokensOut'> & {
      tokensIn: number | null;
      tokensOut: number | null;
    })[];
    return rows.map(({ tokensIn, tokensOut, ...rest }) => ({
      ...rest,
      ...(tokensIn === null ? {} : { tokensIn }),
      ...(tokensOut === null ? {} : { tokensOut }),
    }));
  }
}
