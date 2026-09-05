import { describe, expect, it } from "vitest";
import { cacheKeyFor } from "../src/lib/target";
import { hashIp, RELEASES_PER_DAY, Store } from "../src/store";
import type { Report } from "../src/types";
import { verdictPath } from "../src/ui/pages";

interface VerdictRow {
  cache_key: string;
  owner: string;
  name: string;
  ref: string;
  report_json: string;
  writeup: string | null;
  writeup_model: string | null;
  writeup_degraded_reason: string | null;
  created_at: number;
}

/**
 * A minimal in-memory stand-in for the D1 statements the Store issues. It
 * understands only those shapes and throws on anything else, so a query this
 * fake does not model cannot pass silently.
 */
function fakeDb(opts: { returning?: "row" | "none"; counterReadable?: boolean; broken?: boolean } = {}) {
  const counters = new Map<string, number>();
  const verdicts: VerdictRow[] = [];
  const prunes = { count: 0 };
  const returning = opts.returning ?? "row";
  const counterReadable = opts.counterReadable ?? true;
  // A monotonic stand-in for wall-clock order: tests care about which insert
  // came first, not real elapsed time, and two inserts in the same
  // millisecond must still be distinguishable.
  let seq = 0;

  const db = {
    counters,
    verdicts,
    prunes,
    prepare(sql: string) {
      if (opts.broken) throw new Error("storage unavailable");
      const text = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async run() {
          if (text.startsWith("UPDATE rate_limits SET count = count - 1")) {
            const key = `${args[0]}|${args[1]}`;
            const current = counters.get(key) ?? 0;
            if (current > 0) counters.set(key, current - 1);
            return;
          }
          if (text.startsWith("DELETE FROM rate_limits WHERE day <")) {
            prunes.count++;
            for (const key of [...counters.keys()]) {
              if (key.split("|")[1]! < String(args[0])) counters.delete(key);
            }
            return;
          }
          if (text.startsWith("INSERT INTO verdicts")) {
            const [
              cacheKey,
              host,
              owner,
              name,
              ref,
              verdict,
              reportJson,
              writeup,
              writeupModel,
              writeupDegradedReason,
            ] = args as [string, string, string, string, string, string, string, string | null, string | null, string | null];
            void host;
            void verdict;
            const existing = verdicts.find((v) => v.cache_key === cacheKey);
            if (existing) {
              existing.report_json = reportJson;
              const effectiveWriteup = writeup ?? existing.writeup;
              existing.writeup_degraded_reason =
                effectiveWriteup !== null
                  ? null
                  : (existing.writeup_degraded_reason ?? writeupDegradedReason);
              existing.writeup = effectiveWriteup;
              existing.writeup_model = writeupModel ?? existing.writeup_model;
            } else {
              verdicts.push({
                cache_key: cacheKey,
                owner,
                name,
                ref,
                report_json: reportJson,
                writeup,
                writeup_model: writeupModel,
                writeup_degraded_reason: writeupDegradedReason,
                created_at: seq++,
              });
            }
            return;
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
        async first<T>(): Promise<T | null> {
          if (text.startsWith("INSERT INTO rate_limits") && text.endsWith("RETURNING count")) {
            const key = `${args[0]}|${args[1]}`;
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            // D1 documents an empty result set for write statements, so a
            // driver that ignores RETURNING is a shape this has to survive.
            return returning === "row" ? ({ count } as T) : null;
          }
          if (text.startsWith("SELECT count FROM rate_limits")) {
            if (!counterReadable) return null;
            const count = counters.get(`${args[0]}|${args[1]}`);
            return count === undefined ? null : ({ count } as T);
          }
          if (text.includes("FROM verdicts WHERE cache_key = ?")) {
            return (verdicts.find((v) => v.cache_key === args[0]) ?? null) as T | null;
          }
          if (text.includes("FROM verdicts WHERE host = 'github' AND owner = ? AND name = ? AND ref = ?")) {
            const matches = verdicts
              .filter((v) => v.owner === args[0] && v.name === args[1] && v.ref === args[2])
              .sort((a, b) => b.created_at - a.created_at);
            return (matches[0] ?? null) as T | null;
          }
          if (text.includes("FROM verdicts WHERE host = 'github' AND owner = ? AND name = ?")) {
            const matches = verdicts
              .filter((v) => v.owner === args[0] && v.name === args[1])
              .sort((a, b) => b.created_at - a.created_at);
            return (matches[0] ?? null) as T | null;
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

function storedRow(cacheKey: string, report: Partial<Report["target"]> & { sha: string }): VerdictRow {
  return {
    cache_key: cacheKey,
    owner: report.owner ?? "o",
    name: report.name ?? "r",
    ref: report.sha,
    report_json: JSON.stringify({ target: { cacheKey, ...report } }),
    writeup: null,
    writeup_model: null,
    writeup_degraded_reason: null,
    created_at: 1,
  };
}

const today = new Date().toISOString().slice(0, 10);

describe("rate limiting", () => {
  it("serialises concurrent submissions from one address", async () => {
    // Ten submissions in flight at once must not all see an empty counter. The
    // increment and the comparison are one statement for exactly this reason.
    const db = fakeDb();
    const store = new Store(db as never);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consumeRateLimit("ip", 5)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(db.counters.get(`ip|${today}`)).toBe(10);
  });

  it("refuses once the day's slots are spent", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    for (let i = 0; i < 5; i++) {
      expect((await store.consumeRateLimit("ip", 5)).allowed).toBe(true);
    }
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({ allowed: false, used: 6 });
  });

  it("gives the slot back when the analysis produced nothing", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    await store.consumeRateLimit("ip", 5);
    await store.releaseRateLimit("ip");

    expect(db.counters.get(`ip|${today}`)).toBe(0);
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({ used: 1, allowed: true });
  });

  it("bounds the full collections one failing address can drive in a day", async () => {
    // The worst case stated as arithmetic: an address whose analysis fails every
    // single time. Each failure refunds its slot, so without a cap on the
    // release path the 100 daily submissions each buy a full collection and its
    // whole fetch budget. The bound is the analysis limit plus the releases
    // allowed, and nothing the caller does can widen it.
    const analysesPerDay = 5;
    const submissionsPerDay = 100;
    const db = fakeDb();
    const store = new Store(db as never);

    let collections = 0;
    for (let i = 0; i < submissionsPerDay; i++) {
      if (!(await store.consumeSubmission("ip", submissionsPerDay)).allowed) break;
      if (!(await store.consumeRateLimit("ip", analysesPerDay)).allowed) continue;
      collections++;
      // Every analysis fails after the cache miss.
      await store.releaseRateLimit("ip");
    }

    expect(collections).toBe(analysesPerDay + RELEASES_PER_DAY);
    expect(collections).toBe(10);
    expect(collections).toBeLessThan(submissionsPerDay);
  });

  it("prunes stale counters once per counter rather than once per request", async () => {
    // D1 bills rows read, so a prune on every bump makes each request cost the
    // whole live table. It runs on the first bump of a counter and stale rows
    // are still gone after it.
    const db = fakeDb();
    const store = new Store(db as never);
    db.counters.set("ip|2000-01-01", 3);

    for (let i = 0; i < 10; i++) await store.consumeRateLimit("ip", 100);

    expect(db.counters.has("ip|2000-01-01")).toBe(false);
    expect(db.prunes.count).toBe(1);
  });

  it("never releases below zero", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    await store.releaseRateLimit("ip");
    await store.releaseRateLimit("ip");

    expect(db.counters.get(`ip|${today}`) ?? 0).toBe(0);
  });

  it("still counts when the driver returns no row for a write statement", async () => {
    const db = fakeDb({ returning: "none" });
    const store = new Store(db as never);

    for (let i = 0; i < 5; i++) {
      expect((await store.consumeRateLimit("ip", 5)).allowed, `attempt ${i}`).toBe(true);
    }
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({ allowed: false, used: 6 });
  });

  it("refuses when the counter cannot be read at all, and says why", async () => {
    // Failing open here would disable the daily cap for every address at once.
    // The reason is separate from quota exhaustion so the page does not tell a
    // first-time visitor they spent analyses they never ran.
    const db = fakeDb({ returning: "none", counterReadable: false });
    const store = new Store(db as never);

    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({
      allowed: false,
      reason: "unavailable",
    });
  });

  it("refuses when the storage errors", async () => {
    const store = new Store(fakeDb({ broken: true }) as never);
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({
      allowed: false,
      reason: "unavailable",
    });
  });

  it("marks a genuine exhaustion as quota", async () => {
    const store = new Store(fakeDb() as never);
    for (let i = 0; i < 5; i++) await store.consumeRateLimit("ip", 5);

    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({
      allowed: false,
      reason: "quota",
      used: 6,
    });
  });

  it("counts submissions on their own counter, apart from the analysis slots", async () => {
    // Resolving always reaches upstream, so every submission is charged for it,
    // but on a counter of its own: looking something up must not cost one of
    // the five analyses.
    const db = fakeDb();
    const store = new Store(db as never);

    for (let i = 0; i < 12; i++) {
      expect((await store.consumeSubmission("ip", 100)).allowed, `submission ${i}`).toBe(true);
    }

    expect(db.counters.get(`ip|${today}`) ?? 0, "no analysis slot was spent").toBe(0);
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({ allowed: true, used: 1 });
  });

  it("refuses once the day's submissions are spent", async () => {
    const store = new Store(fakeDb() as never);
    for (let i = 0; i < 100; i++) await store.consumeSubmission("ip", 100);

    expect(await store.consumeSubmission("ip", 100)).toMatchObject({
      allowed: false,
      reason: "quota",
    });
  });

  it("refuses a submission when the counter cannot be read", async () => {
    const store = new Store(fakeDb({ broken: true }) as never);
    expect(await store.consumeSubmission("ip", 100)).toMatchObject({
      allowed: false,
      reason: "unavailable",
    });
  });

  it("drops counters from days that have passed", async () => {
    const db = fakeDb();
    const store = new Store(db as never);
    db.counters.set("someone|2020-01-01", 4);
    db.counters.set("someone-else|2020-06-01", 2);

    await store.consumeRateLimit("ip", 5);

    expect([...db.counters.keys()]).toEqual([`ip|${today}`]);
  });
});

describe("which report a verdict URL resolves to", () => {
  const sha = "abc123";
  const plainKey = cacheKeyFor("o", "r", sha);
  const npmKey = cacheKeyFor("o", "r", sha, {
    kind: "npm",
    packageName: "uv",
    version: "1.0.0",
  });

  it("serves the bare repository report when no package is named", async () => {
    const db = fakeDb();
    db.verdicts.push(storedRow(plainKey, { sha, owner: "o", name: "r" }));
    const store = new Store(db as never);

    const found = await store.getVerdictForQuery("o", "r", sha, null);
    expect(found?.report.target.cacheKey).toBe(plainKey);
  });

  it("serves the registry report when its package and version are named", async () => {
    const db = fakeDb();
    db.verdicts.push(storedRow(plainKey, { sha, owner: "o", name: "r" }));
    db.verdicts.push(storedRow(npmKey, { sha, owner: "o", name: "r" }));
    const store = new Store(db as never);

    const found = await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.0");
    expect(found?.report.target.cacheKey).toBe(npmKey);
  });

  it("answers nothing rather than the repository report when the package report is missing", async () => {
    // Serving the bare repository analysis under a package question is the
    // same silent scope drop the registry cache key exists to prevent: it has
    // no registry-provenance finding and nothing would say so.
    const db = fakeDb();
    db.verdicts.push(storedRow(plainKey, { sha, owner: "o", name: "r" }));
    const store = new Store(db as never);

    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.0")).toBeNull();
    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@2.0.0")).toBeNull();
    expect(await store.getVerdictForQuery("o", "r", sha, "not-a-package-ref")).toBeNull();
  });

  it("finds the report through the address that report advertises", async () => {
    // Round trip: what the redirect points at is what lookup resolves, for a
    // version string the URL parser would otherwise have refused.
    for (const version of ["0.9.0", "1!2.0", "1.0.0+build.1", "nonsense version"]) {
      const registry = { kind: "pypi" as const, packageName: "uv", version };
      const key = cacheKeyFor("o", "r", sha, registry);

      const db = fakeDb();
      db.verdicts.push(storedRow(key, { sha, owner: "o", name: "r" }));
      const store = new Store(db as never);

      const advertised = new URL(
        `https://chainoftrust.dev${verdictPath({
          target: {
            cacheKey: key,
            host: "github",
            owner: "o",
            name: "r",
            requestedRef: "",
            sha,
            defaultBranch: "main",
            registry,
          },
        } as Report)}`,
      );

      const found = await store.getVerdictForQuery(
        "o",
        "r",
        sha,
        advertised.searchParams.get("pkg"),
      );
      expect(found?.report.target.cacheKey, version).toBe(key);
    }
  });

  it("keeps one published version from answering for another", async () => {
    const db = fakeDb();
    db.verdicts.push(storedRow(npmKey, { sha, owner: "o", name: "r" }));
    const store = new Store(db as never);

    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.0")).not.toBeNull();
    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.1")).toBeNull();
  });
});

function reportAt(owner: string, name: string, sha: string): Report {
  return {
    target: {
      cacheKey: cacheKeyFor(owner, name, sha),
      host: "github",
      owner,
      name,
      requestedRef: "",
      sha,
      defaultBranch: "main",
    },
    verdict: "clean",
    findings: [],
    notChecked: [],
    proseExcerpts: [],
    stats: {
      filesInTree: 0,
      totalBytes: 0,
      opaqueBytes: 0,
      filesFetched: 0,
      fetchBudgetExhausted: false,
    },
    generatedAt: "2026-09-05T00:00:00.000Z",
  };
}

describe("why a report carries no writeup", () => {
  it("round trips the degraded reason through put and get", async () => {
    const db = fakeDb();
    const store = new Store(db as never);
    const report = reportAt("o", "r", "abc123");

    await store.putVerdict(report, null, null, "budget");

    const found = await store.getVerdict(report.target.cacheKey);
    expect(found?.writeupDegradedReason).toBe("budget");
    expect(found?.writeup).toBeNull();
  });

  it("clears a previously recorded reason once a real writeup lands", async () => {
    // A retry that later succeeds must not leave the earlier failure's reason
    // attached to a report that now has real prose.
    const db = fakeDb();
    const store = new Store(db as never);
    const report = reportAt("o", "r", "abc123");

    await store.putVerdict(report, null, null, "error");
    await store.putVerdict(report, "The installer does a thing.", "claude-haiku-4-5", null);

    const found = await store.getVerdict(report.target.cacheKey);
    expect(found?.writeup).toBe("The installer does a thing.");
    expect(found?.writeupDegradedReason).toBeNull();
  });

  it("does not attach a later failure's reason to a report that already has prose", async () => {
    // The writeup itself is kept (COALESCE keeps the old one when a later
    // write carries none), so the reason attached to it must agree: a report
    // that still displays its earlier prose must not also carry a stale
    // "why there is no summary" reason underneath it.
    const db = fakeDb();
    const store = new Store(db as never);
    const report = reportAt("o", "r", "abc123");

    await store.putVerdict(report, "The installer does a thing.", "claude-haiku-4-5", null);
    await store.putVerdict(report, null, null, "error");

    const found = await store.getVerdict(report.target.cacheKey);
    expect(found?.writeup).toBe("The installer does a thing.");
    expect(found?.writeupDegradedReason).toBeNull();
  });

  it("treats an unrecognised stored value the same as no reason, never inventing one", async () => {
    const db = fakeDb();
    db.verdicts.push({
      ...storedRow(cacheKeyFor("o", "r", "abc123"), { sha: "abc123", owner: "o", name: "r" }),
      writeup_degraded_reason: "some-future-reason-this-code-does-not-know",
    });
    const store = new Store(db as never);

    const found = await store.getVerdict(cacheKeyFor("o", "r", "abc123"));
    expect(found?.writeupDegradedReason).toBeNull();
  });
});

describe("the most recent report for a repository", () => {
  it("finds the latest across different commits, not just the newest insert order", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    await store.putVerdict(reportAt("o", "r", "older"), null, "m", null);
    await store.putVerdict(reportAt("o", "r", "newer"), null, "m", null);

    const found = await store.getLatestForRepo("o", "r");
    expect(found?.report.target.sha).toBe("newer");
  });

  it("answers nothing for a repository that has never been analysed", async () => {
    const db = fakeDb();
    const store = new Store(db as never);
    expect(await store.getLatestForRepo("o", "unseen")).toBeNull();
  });
});

describe("the stored form of a client address", () => {
  it("never contains the address", async () => {
    const digest = await hashIp("203.0.113.7", { day: "2026-08-10" });
    expect(digest).not.toContain("203.0.113.7");
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rotates with the UTC day", async () => {
    const a = await hashIp("203.0.113.7", { day: "2026-08-10" });
    const b = await hashIp("203.0.113.7", { day: "2026-08-11" });
    expect(a).not.toBe(b);
  });

  it("changes when the salt secret is set, and is stable while it is", async () => {
    const unsalted = await hashIp("203.0.113.7", { day: "2026-08-10" });
    const salted = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s3cret" });
    const again = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s3cret" });

    expect(salted).not.toBe(unsalted);
    expect(again).toBe(salted);
  });

  it("separates two addresses on the same day", async () => {
    const a = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s" });
    const b = await hashIp("203.0.113.8", { day: "2026-08-10", secret: "s" });
    expect(a).not.toBe(b);
  });
});
