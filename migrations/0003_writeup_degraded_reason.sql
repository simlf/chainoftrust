-- Why a stored report carries no written summary, so the page can say
-- honestly whether no provider was ever configured or whether a configured
-- one temporarily failed. NULL means a summary was written; a report from
-- before this column existed also reads as NULL, which renders as no
-- notice at all rather than inventing a reason it never recorded.
ALTER TABLE verdicts ADD COLUMN writeup_degraded_reason TEXT;
