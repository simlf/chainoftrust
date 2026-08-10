import { cacheKeyFor, registryQualifier } from "./lib/target";
import type { Report, StoredVerdict } from "./types";

export interface RateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
  /**
   * Why a refusal happened. "quota" means the address really did spend its
   * analyses. "unavailable" means the counter could not be read, which refuses
   * in the same fail-closed direction but is not a fact about the visitor.
   */
  reason?: "quota" | "unavailable";
}

/**
 * How many spent analysis slots one address can be given back in a UTC day.
 *
 * Small on purpose. Every refund buys another full collection, so this is the
 * only thing standing between a target that fails on every attempt and a replay
 * across the whole submission ceiling.
 */
export const RELEASES_PER_DAY = 5;

/**
 * D1 is the cache, the rate limiter and the budget ledger.
 *
 * Cache identity is the commit SHA, so a popular repository submitted a
 * thousand times costs one analysis. What each counter charges for:
 *
 *  - Reading an existing verdict at its own address costs nothing at all and is
 *    unlimited. Those requests do no upstream work.
 *  - Submitting through the form always costs one submission, because it has to
 *    reach GitHub or a registry to learn the commit SHA before it can know
 *    whether a report already exists.
 *  - A fresh analysis additionally costs one of the five daily analysis slots.
 *    A cache hit never costs one of those.
 */
export class Store {
  constructor(private readonly db: D1Database) {}

  async getVerdict(cacheKey: string): Promise<StoredVerdict | null> {
    const row = await this.db
      .prepare(
        `SELECT report_json, writeup, writeup_model, created_at
           FROM verdicts WHERE cache_key = ?`,
      )
      .bind(cacheKey)
      .first<{
        report_json: string;
        writeup: string | null;
        writeup_model: string | null;
        created_at: number;
      }>();
    return row ? hydrate(row) : null;
  }

  /**
   * Most recent verdict for one commit, whichever cache key it was filed under.
   * A registry submission and a bare repository submission at the same commit
   * are separate rows, and the /r/github/:owner/:name/:sha route names neither,
   * so it resolves to the newest of them.
   */
  async getVerdictAtCommit(
    owner: string,
    name: string,
    sha: string,
  ): Promise<StoredVerdict | null> {
    const row = await this.db
      .prepare(
        `SELECT report_json, writeup, writeup_model, created_at
           FROM verdicts
          WHERE host = 'github' AND owner = ? AND name = ? AND ref = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(owner.toLowerCase(), name.toLowerCase(), sha)
      .first<{
        report_json: string;
        writeup: string | null;
        writeup_model: string | null;
        created_at: number;
      }>();
    return row ? hydrate(row) : null;
  }

  /** Most recent verdict for a repository, whatever commit it was pinned to. */
  async getLatestForRepo(owner: string, name: string): Promise<StoredVerdict | null> {
    const row = await this.db
      .prepare(
        `SELECT report_json, writeup, writeup_model, created_at
           FROM verdicts
          WHERE host = 'github' AND owner = ? AND name = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<{
        report_json: string;
        writeup: string | null;
        writeup_model: string | null;
        created_at: number;
      }>();
    return row ? hydrate(row) : null;
  }

  async putVerdict(
    report: Report,
    writeup: string | null,
    writeupModel: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO verdicts
           (cache_key, host, owner, name, ref, verdict, report_json, writeup, writeup_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           report_json = excluded.report_json,
           writeup = COALESCE(excluded.writeup, verdicts.writeup),
           writeup_model = COALESCE(excluded.writeup_model, verdicts.writeup_model)`,
      )
      .bind(
        report.target.cacheKey,
        report.target.host,
        report.target.owner.toLowerCase(),
        report.target.name.toLowerCase(),
        report.target.sha,
        report.verdict,
        JSON.stringify(report),
        writeup,
        writeupModel,
        Date.now(),
      )
      .run();
  }

  /**
   * Consume one submission, which is what pays for resolving a target.
   *
   * Every POST to /analyse resolves before anything else can be decided, and
   * resolving always reaches upstream: the repository and the commit, plus a
   * registry document for an npm or PyPI target. Those requests are really
   * spent, so this counter is never given back, not even when the analysis
   * turns out to be cached. Its ceiling is generous: it exists to stop a
   * scripted replay, not to ration a person looking things up.
   */
  async consumeSubmission(ipHash: string, limit: number): Promise<RateLimitResult> {
    return this.consumeCounter(`resolve:${ipHash}`, limit);
  }

  /**
   * Consume one fresh-analysis slot, once a cache miss means real work.
   *
   * Given back only when that work failed, by releaseRateLimit. A cache hit
   * never reaches this, so a cached report never costs an analysis.
   */
  async consumeRateLimit(ipHash: string, limit: number): Promise<RateLimitResult> {
    return this.consumeCounter(ipHash, limit);
  }

  /**
   * The increment and the comparison have to be one statement. Reading the
   * count first and writing it afterwards lets ten concurrent submissions from
   * one address all read zero and all run, so a daily limit would only hold for
   * strictly sequential requests.
   */
  private async consumeCounter(key: string, limit: number): Promise<RateLimitResult> {
    const day = utcDay();
    const atLimit: RateLimitResult = {
      allowed: false,
      used: limit + 1,
      limit,
      reason: "unavailable",
    };

    const used = await this.bump(key, day);

    // A counter nobody can read is treated as spent. A storage fault that made
    // the limiter answer "not yet at the limit" would disable the daily cap for
    // every address at once, which is the one direction it must never fail in.
    if (used === null) return atLimit;

    // Yesterday's counters answer no question anyone can ask, and nothing else
    // ever deletes them, so the table would grow for the life of the deployment.
    try {
      await this.db.prepare(`DELETE FROM rate_limits WHERE day < ?`).bind(day).run();
    } catch {
      // The prune is housekeeping. Failing it does not change the decision.
    }

    return used <= limit
      ? { allowed: true, used, limit }
      : { allowed: false, used, limit, reason: "quota" };
  }

  /**
   * Give back an analysis slot spent on work that produced no report.
   *
   * The release path carries its own daily allowance, and the caller cannot opt
   * out of it: refunding without a bound lets one address whose analyses always
   * fail replay a full collection for every submission it has, which is the
   * frugality ceiling this counter exists to hold. Past the allowance a failure
   * simply costs the slot. The worst case per address per UTC day is therefore
   * the analysis limit plus RELEASES_PER_DAY full collections.
   */
  async releaseRateLimit(ipHash: string): Promise<void> {
    const releases = await this.bump(`release:${ipHash}`, utcDay());
    // A release that could not be counted is not granted. Leaving the slot
    // spent is the safe direction, the same one every other fault takes here.
    if (releases === null || releases > RELEASES_PER_DAY) return;

    try {
      await this.db
        .prepare(
          `UPDATE rate_limits SET count = count - 1
            WHERE ip_hash = ? AND day = ? AND count > 0`,
        )
        .bind(ipHash, utcDay())
        .run();
    } catch {
      // A counter that cannot be decremented leaves the slot spent, which is
      // the safe direction for a limiter.
    }
  }

  /**
   * Increment one daily counter and read it back in the same statement.
   *
   * RETURNING keeps the increment and the count one round trip, which is what
   * serialises concurrent requests. D1 documents an empty result set for write
   * statements, so a driver that does not carry RETURNING rows falls back to a
   * second read, and a counter that cannot be read at all reads as null so
   * every caller can decide in the safe direction.
   */
  private async bump(key: string, day: string): Promise<number | null> {
    try {
      const row = await this.db
        .prepare(
          `INSERT INTO rate_limits (ip_hash, day, count) VALUES (?, ?, 1)
           ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(key, day)
        .first<{ count: number }>();
      if (typeof row?.count === "number") return row.count;

      const readBack = await this.db
        .prepare(`SELECT count FROM rate_limits WHERE ip_hash = ? AND day = ?`)
        .bind(key, day)
        .first<{ count: number }>();
      return typeof readBack?.count === "number" ? readBack.count : null;
    } catch {
      return null;
    }
  }

  /**
   * The report a verdict URL names.
   *
   * A commit can hold a bare repository report and one report per published
   * package. `pkg` names which, as `npm:name@version`. A qualifier that names
   * no stored row resolves to nothing rather than to the bare repository
   * report: answering a narrower question with a wider analysis is the silent
   * scope drop the registry cache key exists to prevent.
   */
  async getVerdictForQuery(
    owner: string,
    name: string,
    sha: string,
    pkg: string | null,
  ): Promise<StoredVerdict | null> {
    if (pkg) {
      const registry = registryQualifier(pkg);
      if (!registry) return null;
      return this.getVerdict(cacheKeyFor(owner, name, sha, registry));
    }
    const plain = await this.getVerdict(cacheKeyFor(owner, name, sha));
    return plain ?? (await this.getVerdictAtCommit(owner, name, sha));
  }

  async budgetRemainingMicroCents(ceilingCents: number): Promise<number> {
    const month = new Date().toISOString().slice(0, 7);
    const row = await this.db
      .prepare(`SELECT micro_cents FROM model_spend WHERE month = ?`)
      .bind(month)
      .first<{ micro_cents: number }>();
    const spent = row?.micro_cents ?? 0;
    return Math.max(0, ceilingCents * 1_000_000 - spent);
  }

  async recordSpend(microCents: number): Promise<void> {
    if (microCents <= 0) return;
    const month = new Date().toISOString().slice(0, 7);
    await this.db
      .prepare(
        `INSERT INTO model_spend (month, micro_cents, calls) VALUES (?, ?, 1)
         ON CONFLICT(month) DO UPDATE SET
           micro_cents = micro_cents + excluded.micro_cents,
           calls = calls + 1`,
      )
      .bind(month, Math.round(microCents))
      .run();
  }
}

function hydrate(row: {
  report_json: string;
  writeup: string | null;
  writeup_model: string | null;
  created_at: number;
}): StoredVerdict | null {
  try {
    return {
      report: JSON.parse(row.report_json) as Report,
      writeup: row.writeup,
      writeupModel: row.writeup_model,
      cached: true,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/** The UTC day a counter belongs to. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Salted hash of the client IP. The raw address is never written down: the
 * rate limiter only needs to recognise a repeat visitor within one day.
 *
 * The salt matters. IPv4 is small enough to enumerate against a known-constant
 * salt in seconds, so the day is always mixed in and RATE_LIMIT_SALT is mixed
 * in when it is set. Without the secret the digest is still enumerable by
 * anyone who can read the table, which is why the day rotation is the floor
 * and not the guarantee. Secrets stay optional by design: an absent salt
 * degrades the property, it does not stop the Worker booting.
 */
export async function hashIp(
  ip: string,
  opts: { day: string; secret?: string },
): Promise<string> {
  const salt = `${opts.secret ?? "chainoftrust"}:${opts.day}`;
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
