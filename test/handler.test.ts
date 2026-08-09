import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

/**
 * A stand-in for the D1 statements the Worker issues on the submit path. It
 * models only those shapes and throws on anything else, so a query it does not
 * model cannot pass silently.
 */
function fakeDb() {
  const counters = new Map<string, number>();
  const verdicts = new Map<string, string>();

  return {
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
          if (text.startsWith("DELETE FROM rate_limits WHERE day <")) return;
          if (text.startsWith("UPDATE rate_limits SET count = count - 1")) {
            const key = `${args[0]}|${args[1]}`;
            counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1));
            return;
          }
          if (text.startsWith("INSERT INTO verdicts")) {
            verdicts.set(String(args[0]), String(args[6]));
            return;
          }
          if (text.startsWith("INSERT INTO model_spend")) return;
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
            const json = verdicts.get(String(args[0]));
            return json
              ? ({ report_json: json, writeup: null, writeup_model: null, created_at: 1 } as T)
              : null;
          }
          if (text.startsWith("SELECT micro_cents FROM model_spend")) return null;
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };
}

const REPO = {
  full_name: "o/r",
  description: null,
  fork: false,
  archived: false,
  default_branch: "main",
  stargazers_count: 1,
  open_issues_count: 0,
  pushed_at: "2026-08-01T00:00:00Z",
  created_at: "2020-01-01T00:00:00Z",
  homepage: null,
  license: null,
};

/** Answers the two calls a successful resolution needs, 404 for everything else. */
function stubGithub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.github.com/repos/o/r") {
        return new Response(JSON.stringify(REPO), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/o/r/commits/main") {
        return new Response(JSON.stringify({ sha: "abc123" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
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

const submit = (target: string) =>
  new Request("https://chainoftrust.dev/analyse", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7" },
    body: new URLSearchParams({ target }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submissions that resolve to nothing", () => {
  it("are free up to the ceiling, then start costing analysis slots, then stop", async () => {
    // Resolution runs before any slot is consumed, so without a bound a name
    // that does not exist can be replayed indefinitely, each attempt still
    // spending an upstream fetch.
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(submit(`nobody/repo-${i}`), env);
      statuses.push(res.status);
    }

    // Ten free, then five that spend a slot each, then refusal.
    expect(statuses.slice(0, 15)).toEqual(Array(15).fill(404));
    expect(statuses.slice(15)).toEqual(Array(5).fill(429));

    const upstream = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(upstream, "a refused submission must not reach GitHub").toBe(15);
  });

  it("cost no analysis slot while they are under the ceiling", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    for (let i = 0; i < 10; i++) await worker.fetch(submit(`nobody/repo-${i}`), env);

    const slots = [...db.counters.entries()].filter(([key]) => !key.startsWith("resolve:"));
    expect(slots, "a mistyped name must not cost an analysis").toEqual([]);
  });

  it("leave a submission that does resolve working afterwards", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    for (let i = 0; i < 12; i++) await worker.fetch(submit(`nobody/repo-${i}`), env);

    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/r/github/o/r/abc123");
    expect(db.verdicts.size).toBe(1);
  });

  it("leave a cached report free even past the ceiling", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    await worker.fetch(submit("o/r"), env);
    for (let i = 0; i < 12; i++) await worker.fetch(submit(`nobody/repo-${i}`), env);
    const spentBefore = db.counters.get(
      [...db.counters.keys()].find((k) => !k.startsWith("resolve:"))!,
    );

    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(303);

    const spentAfter = db.counters.get(
      [...db.counters.keys()].find((k) => !k.startsWith("resolve:"))!,
    );
    expect(spentAfter, "a cache hit stays free").toBe(spentBefore);
  });
});
