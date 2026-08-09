import { describe, expect, it } from "vitest";
import { cacheKeyFor } from "../src/lib/target";
import { hashIp, Store } from "../src/store";
import type { Report } from "../src/types";

interface VerdictRow {
  cache_key: string;
  owner: string;
  name: string;
  ref: string;
  report_json: string;
  writeup: string | null;
  writeup_model: string | null;
  created_at: number;
}

/**
 * A minimal in-memory stand-in for the D1 statements the Store issues. It
 * understands only those shapes and throws on anything else, so a query this
 * fake does not model cannot pass silently.
 */
function fakeDb() {
  const counters = new Map<string, number>();
  const verdicts: VerdictRow[] = [];

  const db = {
    counters,
    verdicts,
    prepare(sql: string) {
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
            for (const key of [...counters.keys()]) {
              if (key.split("|")[1]! < String(args[0])) counters.delete(key);
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
            return { count } as T;
          }
          if (text.startsWith("SELECT count FROM rate_limits")) {
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
    await store.refundRateLimit("ip");

    expect(db.counters.get(`ip|${today}`)).toBe(0);
    expect(await store.consumeRateLimit("ip", 5)).toMatchObject({ used: 1, allowed: true });
  });

  it("never refunds below zero", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    await store.refundRateLimit("ip");
    await store.refundRateLimit("ip");

    expect(db.counters.get(`ip|${today}`) ?? 0).toBe(0);
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

  it("keeps one published version from answering for another", async () => {
    const db = fakeDb();
    db.verdicts.push(storedRow(npmKey, { sha, owner: "o", name: "r" }));
    const store = new Store(db as never);

    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.0")).not.toBeNull();
    expect(await store.getVerdictForQuery("o", "r", sha, "npm:uv@1.0.1")).toBeNull();
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
