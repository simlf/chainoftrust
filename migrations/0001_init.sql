-- Verdicts are cached by the exact commit SHA (or registry version) that was
-- analysed. The same commit is never analysed twice.
CREATE TABLE IF NOT EXISTS verdicts (
  cache_key      TEXT PRIMARY KEY,
  host           TEXT NOT NULL,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  ref            TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  report_json    TEXT NOT NULL,
  writeup        TEXT,
  writeup_model  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS verdicts_target
  ON verdicts (host, owner, name, created_at DESC);

-- Rate limiting. The IP is stored as a salted SHA-256 prefix, never in the
-- clear. Rows are only meaningful for the day they belong to.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash   TEXT NOT NULL,
  day       TEXT NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day)
);

-- Running model spend for the current UTC month, in micro-cents, so a single
-- cheap call is still countable without floating point.
CREATE TABLE IF NOT EXISTS model_spend (
  month           TEXT PRIMARY KEY,
  micro_cents     INTEGER NOT NULL,
  calls           INTEGER NOT NULL
);
