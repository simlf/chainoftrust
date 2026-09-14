import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { cacheKeyFor } from "../src/lib/target";
import type { Report } from "../src/types";

/**
 * The edge-cache contract this suite proves: a SHA-pinned verdict URL is
 * immutable by construction, so a repeat view of a shared link must be served
 * from the Cache API without a single D1 statement running; everything whose
 * content can change (the repo-latest route, a 404 for a report that does not
 * exist yet, error pages) must never be put into that cache.
 */

function report(): Report {
  return {
    target: {
      cacheKey: cacheKeyFor("o", "r", "abc123"),
      host: "github",
      owner: "o",
      name: "r",
      requestedRef: "",
      sha: "abc123",
      defaultBranch: "main",
    },
    verdict: "clean",
    findings: [],
    notChecked: [],
    proseExcerpts: [],
    stats: {
      filesInTree: 1,
      totalBytes: 1,
      opaqueBytes: 0,
      filesFetched: 1,
      fetchBudgetExhausted: false,
    },
    generatedAt: "2026-08-10T00:00:00.000Z",
  };
}

/**
 * Models only the reads a verdict lookup can issue and counts every one of
 * them, so "a cache hit skips the D1 read" is asserted on the counter, not on
 * intent. Any statement outside those reads throws loudly.
 */
function fakeDb() {
  const byCacheKey = new Map<string, string>();
  const db = {
    reads: 0,
    seed(r: Report) {
      byCacheKey.set(r.target.cacheKey, JSON.stringify(r));
    },
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async run() {
          throw new Error(`unmodelled statement: ${text}`);
        },
        async first<T>(): Promise<T | null> {
          db.reads++;
          if (text.includes("FROM verdicts WHERE cache_key = ?")) {
            const json = byCacheKey.get(String(args[0]));
            return json ? (row(json) as T) : null;
          }
          if (
            text.includes("FROM verdicts") &&
            text.includes("WHERE host = 'github' AND owner = ? AND name = ?")
          ) {
            // Covers both getLatestForRepo and the getVerdictAtCommit
            // fallback; either way, serve the one seeded report for o/r.
            const [owner, name] = args as [string, string];
            const seeded = byCacheKey.get(cacheKeyFor("o", "r", "abc123"));
            return owner === "o" && name === "r" && seeded ? (row(seeded) as T) : null;
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

function row(json: string) {
  return {
    report_json: json,
    writeup: null,
    writeup_model: null,
    writeup_degraded_reason: null,
    created_at: 0,
  };
}

/**
 * The Cache API stand-in stores a serialised copy per URL, the only key the
 * real edge cache has, which is exactly what makes the format-negotiation
 * test below meaningful: if HTML and JSON collapse onto one key here, they
 * collapse on Cloudflare too.
 */
function fakeCaches() {
  const stored = new Map<string, { body: string; status: number; headers: [string, string][] }>();
  const dflt = {
    puts: 0,
    async match(req: Request): Promise<Response | undefined> {
      const hit = stored.get(req.url);
      if (!hit) return undefined;
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    },
    async put(req: Request, res: Response): Promise<void> {
      dflt.puts++;
      stored.set(req.url, {
        body: await res.text(),
        status: res.status,
        headers: [...res.headers],
      });
    },
  };
  return { default: dflt, stored };
}

function envWith(db: ReturnType<typeof fakeDb>): Env {
  return {
    DB: db as never,
    MODEL_BUDGET_CENTS_PER_MONTH: "300",
    MODEL_ID: "claude-haiku-4-5",
    FRESH_ANALYSES_PER_IP_PER_DAY: "5",
    CONTACT_EMAIL: "hello@chainoftrust.dev",
  };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://chainoftrust.dev${path}`, { headers });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("edge caching the SHA-pinned verdict route", () => {
  it("serves a repeat view from the edge cache with zero D1 reads", async () => {
    const caches = fakeCaches();
    vi.stubGlobal("caches", caches);
    const db = fakeDb();
    db.seed(report());
    const env = envWith(db);

    const first = await worker.fetch(get("/r/github/o/r/abc123"), env);
    expect(first.status).toBe(200);
    expect(db.reads).toBeGreaterThan(0);
    expect(caches.default.puts).toBe(1);
    const firstBody = await first.text();

    const readsAfterFirst = db.reads;
    const second = await worker.fetch(get("/r/github/o/r/abc123"), env);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstBody);
    expect(db.reads, "a cache hit must not touch D1 at all").toBe(readsAfterFirst);
  });

  it("keeps HTML and JSON for the same URL under distinct cache keys", async () => {
    const caches = fakeCaches();
    vi.stubGlobal("caches", caches);
    const db = fakeDb();
    db.seed(report());
    const env = envWith(db);

    const html = await worker.fetch(get("/r/github/o/r/abc123"), env);
    expect(html.headers.get("content-type")).toContain("text/html");

    // Same URL, but an agent asking for JSON via the Accept header: the
    // cached HTML page must not come back.
    const json = await worker.fetch(
      get("/r/github/o/r/abc123", { accept: "application/json" }),
      env,
    );
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(caches.default.puts, "two formats, two cache entries").toBe(2);

    // And each format now hits its own entry with no further D1 read.
    const reads = db.reads;
    const htmlAgain = await worker.fetch(get("/r/github/o/r/abc123"), env);
    const jsonAgain = await worker.fetch(
      get("/r/github/o/r/abc123", { accept: "application/json" }),
      env,
    );
    expect(htmlAgain.headers.get("content-type")).toContain("text/html");
    expect(jsonAgain.headers.get("content-type")).toContain("application/json");
    expect(db.reads).toBe(reads);
  });

  it("never caches the repo-latest route, which is mutable by design", async () => {
    const caches = fakeCaches();
    vi.stubGlobal("caches", caches);
    const db = fakeDb();
    db.seed(report());
    const env = envWith(db);

    const first = await worker.fetch(get("/r/github/o/r"), env);
    expect(first.status).toBe(200);
    const reads = db.reads;

    const second = await worker.fetch(get("/r/github/o/r"), env);
    expect(second.status).toBe(200);
    expect(caches.default.puts, "nothing on the mutable route is ever put").toBe(0);
    expect(caches.stored.size).toBe(0);
    expect(db.reads, "every view of the mutable route pays its own read").toBeGreaterThan(reads);
  });

  it("never caches a 404 for a report that does not exist yet", async () => {
    const caches = fakeCaches();
    vi.stubGlobal("caches", caches);
    const db = fakeDb();
    const env = envWith(db);

    const miss = await worker.fetch(get("/r/github/o/r/abc123"), env);
    expect(miss.status).toBe(404);
    expect(caches.default.puts).toBe(0);

    // The moment the report exists, the same URL must serve it: nothing
    // stale was pinned to the edge by the earlier 404.
    db.seed(report());
    const found = await worker.fetch(get("/r/github/o/r/abc123"), env);
    expect(found.status).toBe(200);
  });

  it("takes the plain uncached path when the Cache API does not exist", async () => {
    // vitest's Node environment has no `caches` global, which is exactly the
    // production-degraded shape this asserts: everything still answers.
    const db = fakeDb();
    db.seed(report());
    const res = await worker.fetch(get("/r/github/o/r/abc123"), envWith(db));
    expect(res.status).toBe(200);
  });
});

describe("robots.txt", () => {
  it("explicitly allows the report pages and names /analyse off-limits", async () => {
    const res = await worker.fetch(get("/robots.txt"), envWith(fakeDb()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /r/");
    expect(body).toContain("Disallow: /analyse");
  });
});
