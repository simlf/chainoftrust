import type { StoredVerdict } from "../types";

/**
 * Which version of the checks produced a report.
 *
 * A stored report is keyed by commit SHA and would otherwise be served for as
 * long as the row exists, so a check fix would never reach a repository that
 * was analysed before it. Every report is stamped with this number at build
 * time (`buildReport`), and a stored report carrying an older one is treated as
 * outdated: the submission path recomputes it instead of serving it, and the
 * verdict page says it is outdated instead of presenting it as current.
 *
 * Bump it, by one, in the same change that alters what a report says for the
 * same commit: a collector reading a file differently, a finding added,
 * removed, reworded or re-graded, a concern id changed, or the scoring
 * arithmetic. Do not bump it for a change that leaves every report's content
 * as it was (page styling, a new route, a refactor), because each bump makes
 * every stored report recomputable and so spends fresh analyses and model
 * calls on the next submission of each one.
 *
 * A report stored before this stamp existed carries no version and reads as 0,
 * which is always outdated.
 *
 * History (one line per bump, newest last):
 * 1: first stamped version. Every report stored before it is recomputed on
 *    its next submission.
 */
export const ANALYSER_VERSION = 1;

/**
 * Default ceiling on how old a stored report may be before it is recomputed
 * on its next submission even with the checks unchanged, because what it
 * reports from upstream (a release's assets, a registry document, a
 * Scorecard result) can move without the commit moving. Configurable through
 * REPORT_MAX_AGE_DAYS; recomputation stays lazy either way, never scheduled.
 */
export const DEFAULT_REPORT_MAX_AGE_DAYS = 30;

export type Staleness = "outdated-checks" | "expired";

/**
 * Why a stored report should not be served as current, or null when it can
 * be. An older check version wins over age, because it is the stronger claim:
 * the findings themselves may be wrong, not merely old.
 */
export function staleness(
  stored: Pick<StoredVerdict, "report" | "createdAt">,
  maxAgeMs: number,
  now: number = Date.now(),
): Staleness | null {
  if ((stored.report.analyserVersion ?? 0) < ANALYSER_VERSION) return "outdated-checks";
  if (now - stored.createdAt > maxAgeMs) return "expired";
  return null;
}
