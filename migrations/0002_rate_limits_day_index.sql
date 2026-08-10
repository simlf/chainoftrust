-- The primary key on rate_limits is (ip_hash, day), which no predicate on day
-- alone can use, so pruning stale counters would read every live row. This
-- index makes that delete a range over the days being removed.
CREATE INDEX IF NOT EXISTS rate_limits_day ON rate_limits (day);
