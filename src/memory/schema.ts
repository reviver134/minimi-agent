// Tables in use so far. answer_records and sources arrive with the sessions
// that write them (docs/PLAN.md, data model).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  user_name    TEXT NOT NULL UNIQUE,          -- normalised: trimmed, lower case
  timezone     TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL                  -- UTC, ISO 8601
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id, updated_at);

CREATE TABLE IF NOT EXISTS turns (
  turn_id           TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id),
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  user_message      TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  created_at        TEXT NOT NULL,            -- UTC, ISO 8601
  user_timezone     TEXT NOT NULL             -- the user's timezone when they asked
);
CREATE INDEX IF NOT EXISTS turns_by_user_time ON turns (user_id, created_at);
CREATE INDEX IF NOT EXISTS turns_by_session ON turns (session_id, created_at);

-- No foreign key: a failed turn has metrics but no turns row.
CREATE TABLE IF NOT EXISTS turn_metrics (
  turn_id     TEXT NOT NULL,
  step        TEXT NOT NULL,
  started_ms  INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  status      TEXT NOT NULL,
  tokens_in   INTEGER,
  tokens_out  INTEGER
);
CREATE INDEX IF NOT EXISTS turn_metrics_by_turn ON turn_metrics (turn_id);
`;
