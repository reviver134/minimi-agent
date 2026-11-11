// The SQLite store. Raw turns are the source of truth; every read of sessions
// or turns is scoped by user_id.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Source } from '../agent/webSearch.ts';
import type { Metric, MetricsSink } from '../telemetry/timed.ts';
import type { AnswerRecord } from './records.ts';
import { SCHEMA } from './schema.ts';

export interface User {
  userId: string;
  userName: string;
  timezone: string;
  /** Short statements about the user and how they like answers, kept across chats. */
  profile: string[];
}

export interface Session {
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** What was said before the turns still sent as history, and how many turns it covers. */
  summary: string | null;
  summaryTurns: number;
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

/** A stored turn with its session's title, as recall returns it. */
export interface RecalledTurn extends Turn {
  sessionTitle: string | null;
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

const USER = 'user_id AS userId, user_name AS userName, timezone, profile_json AS profileJson';
const SESSION =
  'session_id AS sessionId, user_id AS userId, title, created_at AS createdAt, updated_at AS updatedAt, ' +
  'summary, summary_turns AS summaryTurns';

function toUser(row: unknown): User | undefined {
  if (!row) return undefined;
  const { profileJson, ...user } = row as Omit<User, 'profile'> & { profileJson: string };
  let profile: unknown;
  try {
    profile = JSON.parse(profileJson);
  } catch {
    profile = [];
  }
  return { ...user, profile: Array.isArray(profile) ? profile.filter((p) => typeof p === 'string') : [] };
}
const TURN =
  'turn_id AS turnId, session_id AS sessionId, user_id AS userId, user_message AS userMessage, ' +
  'assistant_message AS assistantMessage, created_at AS createdAt, user_timezone AS userTimezone';

const RECALLED =
  't.turn_id AS turnId, t.session_id AS sessionId, t.user_id AS userId, t.user_message AS userMessage, ' +
  't.assistant_message AS assistantMessage, t.created_at AS createdAt, t.user_timezone AS userTimezone, ' +
  's.title AS sessionTitle';

export class Store implements MetricsSink {
  private readonly db: DatabaseSync;

  /** path is a file, or ':memory:' for tests. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to an old file.
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'summary')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT; ALTER TABLE sessions ADD COLUMN summary_turns INTEGER NOT NULL DEFAULT 0;');
    }
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
    return toUser(this.db.prepare(`SELECT ${USER} FROM users WHERE user_name = ?`).get(userName))!;
  }

  getUser(userId: string): User | undefined {
    return toUser(this.db.prepare(`SELECT ${USER} FROM users WHERE user_id = ?`).get(userId));
  }

  setProfile(userId: string, profile: string[]): void {
    this.db.prepare('UPDATE users SET profile_json = ? WHERE user_id = ?').run(JSON.stringify(profile), userId);
  }

  // --- sessions ---

  createSession(userId: string, now: Date, title: string | null = null): Session {
    const sessionId = randomUUID();
    const at = now.toISOString();
    this.db
      .prepare('INSERT INTO sessions (session_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, userId, title, at, at);
    return { sessionId, userId, title, createdAt: at, updatedAt: at, summary: null, summaryTurns: 0 };
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

  setSessionSummary(sessionId: string, summary: string, turns: number): void {
    this.db
      .prepare('UPDATE sessions SET summary = ?, summary_turns = ? WHERE session_id = ?')
      .run(summary, turns, sessionId);
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

  countTurns(sessionId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(sessionId) as { n: number }).n;
  }

  /** The session's turn at this position, counting from 0 at the oldest. */
  turnAt(userId: string, sessionId: string, index: number): Turn | undefined {
    return this.db
      .prepare(
        `SELECT ${TURN} FROM turns WHERE user_id = ? AND session_id = ? ORDER BY created_at, rowid LIMIT 1 OFFSET ?`,
      )
      .get(userId, sessionId, index) as Turn | undefined;
  }

  hasTurn(turnId: string): boolean {
    return this.db.prepare('SELECT 1 FROM turns WHERE turn_id = ?').get(turnId) !== undefined;
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

  // --- answer records ---

  setAnswerRecord(record: AnswerRecord): void {
    this.db
      .prepare(
        `INSERT INTO answer_records (turn_id, topic, entities_json, claims_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (turn_id) DO UPDATE SET topic = excluded.topic, entities_json = excluded.entities_json,
           claims_json = excluded.claims_json`,
      )
      .run(record.turnId, record.topic, JSON.stringify(record.entities), JSON.stringify(record.claims), record.createdAt);
  }

  getAnswerRecord(turnId: string): AnswerRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT turn_id AS turnId, topic, entities_json AS entities, claims_json AS claims, created_at AS createdAt
         FROM answer_records WHERE turn_id = ?`,
      )
      .get(turnId) as { turnId: string; topic: string; entities: string; claims: string; createdAt: string } | undefined;
    return row && { ...row, entities: JSON.parse(row.entities), claims: JSON.parse(row.claims) };
  }

  // --- recall: always by user_id, never by session ---

  /** The user's turns with created_at in [fromUtc, toUtc), oldest first. */
  turnsBetween(userId: string, fromUtc: string, toUtc: string, limit = 200): RecalledTurn[] {
    return this.db
      .prepare(
        `SELECT ${RECALLED} FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
         WHERE t.user_id = ? AND t.created_at >= ? AND t.created_at < ?
         ORDER BY t.created_at, t.rowid LIMIT ?`,
      )
      .all(userId, fromUtc, toUtc, limit) as unknown as RecalledTurn[];
  }

  /** The user's turns that mention any of the keywords in the question or the answer, newest first. */
  turnsMentioning(userId: string, keywords: string[], limit = 50): RecalledTurn[] {
    if (keywords.length === 0) return [];
    const like = "(t.user_message LIKE ? ESCAPE '\\' OR t.assistant_message LIKE ? ESCAPE '\\')";
    const patterns = keywords.flatMap((k) => {
      const p = `%${k.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return [p, p];
    });
    return this.db
      .prepare(
        `SELECT ${RECALLED} FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
         WHERE t.user_id = ? AND (${keywords.map(() => like).join(' OR ')})
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
      )
      .all(userId, ...patterns, limit) as unknown as RecalledTurn[];
  }

  /** The user's most recent turns, newest first. */
  latestTurns(userId: string, limit: number): RecalledTurn[] {
    return this.db
      .prepare(
        `SELECT ${RECALLED} FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
         WHERE t.user_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
      )
      .all(userId, limit) as unknown as RecalledTurn[];
  }

  /** When the user's closest turn before fromUtc and closest turn at or after toUtc were made. */
  nearestTurnTimes(userId: string, fromUtc: string, toUtc: string): { before?: string; after?: string } {
    const before = this.db
      .prepare('SELECT MAX(created_at) AS at FROM turns WHERE user_id = ? AND created_at < ?')
      .get(userId, fromUtc) as { at: string | null };
    const after = this.db
      .prepare('SELECT MIN(created_at) AS at FROM turns WHERE user_id = ? AND created_at >= ?')
      .get(userId, toUtc) as { at: string | null };
    return { ...(before.at ? { before: before.at } : {}), ...(after.at ? { after: after.at } : {}) };
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
