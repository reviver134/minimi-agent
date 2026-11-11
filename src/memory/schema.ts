// The tables (docs/PLAN.md, data model). Raw turns are the source of truth;
// answer_records, the profile and session summaries are derived from them.
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

-- Every search result the model was shown in a turn; n is its citation number.
CREATE TABLE IF NOT EXISTS sources (
  turn_id      TEXT NOT NULL REFERENCES turns(turn_id),
  n            INTEGER NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (turn_id, n)
);

-- The checkable content of an answer: entities and claims {entity, attribute, value, asOf, sourceN}.
CREATE TABLE IF NOT EXISTS answer_records (
  turn_id       TEXT PRIMARY KEY REFERENCES turns(turn_id),
  topic         TEXT NOT NULL,
  entities_json TEXT NOT NULL,
  claims_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

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
