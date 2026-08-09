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
    if (!row) return null;

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
    if (!row) return null;
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
   * Consume one fresh-analysis slot. Called only when a cache miss means real
   * work; a cache hit never reaches this.
   */
  async consumeRateLimit(ipHash: string, limit: number): Promise<RateLimitResult> {
    const day = new Date().toISOString().slice(0, 10);

    await this.db
      .prepare(
        `INSERT INTO rate_limits (ip_hash, day, count) VALUES (?, ?, 1)
         ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1`,
      )
      .bind(ipHash, day)
      .run();

    const row = await this.db
      .prepare(`SELECT count FROM rate_limits WHERE ip_hash = ? AND day = ?`)
      .bind(ipHash, day)
      .first<{ count: number }>();

    const used = row?.count ?? 1;
    return { allowed: used <= limit, used, limit };
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

/**
 * Salted hash of the client IP. The raw address is never written down: the
 * rate limiter only needs to recognise a repeat visitor within one day.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
