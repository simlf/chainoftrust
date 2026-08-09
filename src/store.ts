import { cacheKeyFor, registryQualifier } from "./lib/target";
import type { Report, StoredVerdict } from "./types";

export interface RateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * D1 is the cache, the rate limiter and the budget ledger.
 *
 * Cache identity is the commit SHA. A popular repository submitted a thousand
 * times costs one analysis, and a cache hit is free, unlimited and never counts
 * against anyone's quota, because punishing cache hits would discourage the
 * exact behaviour the product wants.
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
   * Consume one fresh-analysis slot, before the work starts.
   *
   * The increment and the comparison have to be one statement. Reading the
   * count first and writing it afterwards lets ten concurrent submissions from
   * one address all read zero and all run, so the daily limit would only hold
   * for strictly sequential requests. A submission that then fails is refunded.
   * A cache hit never reaches this.
   */
  async consumeRateLimit(ipHash: string, limit: number): Promise<RateLimitResult> {
    const day = utcDay();

    // RETURNING makes the increment and the count one round trip. Reading the
    // count back in a second statement would let concurrent submissions see the
    // same value and all decide they were within the limit.
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits (ip_hash, day, count) VALUES (?, ?, 1)
         ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(ipHash, day)
      .first<{ count: number }>();

    // Yesterday's counters answer no question anyone can ask, and nothing else
    // ever deletes them, so the table would grow for the life of the deployment.
    await this.db.prepare(`DELETE FROM rate_limits WHERE day < ?`).bind(day).run();

    const used = row?.count ?? 1;
    return { allowed: used <= limit, used, limit };
  }

  /**
   * Give back a slot consumed by an analysis that produced nothing. The limit
   * counts analyses that produced a report, so a transient GitHub or model
   * failure must not cost a submitter one of their five.
   */
  async refundRateLimit(ipHash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE rate_limits SET count = count - 1
          WHERE ip_hash = ? AND day = ? AND count > 0`,
      )
      .bind(ipHash, utcDay())
      .run();
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
