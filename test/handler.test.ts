import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

/**
 * A stand-in for the D1 statements the Worker issues on the submit path. It
 * models only those shapes and throws on anything else, so a query it does not
 * model cannot pass silently.
 */
function fakeDb(opts: { failVerdictWrites?: boolean } = {}) {
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
            // Modelling the analysis that gets all the way to publication and
            // then produces nothing, which is the case the release path pays
            // a slot back for.
            if (opts.failVerdictWrites) throw new Error("verdict write failed");
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

const slotsOf = (db: ReturnType<typeof fakeDb>) =>
  [...db.counters.entries()]
    .filter(([key]) => !key.startsWith("resolve:"))
    .map(([, count]) => count)
    .reduce((a, b) => a + b, 0);

const submissionsOf = (db: ReturnType<typeof fakeDb>) =>
  [...db.counters.entries()]
    .filter(([key]) => key.startsWith("resolve:"))
    .map(([, count]) => count)
    .reduce((a, b) => a + b, 0);

const read = (path: string) => new Request(`https://chainoftrust.dev${path}`);

describe("what a submission costs", () => {
  it("charges a cached report one submission and no analysis slot", async () => {
    // Resolving reaches GitHub whether or not the report turns out to be
    // cached, so the submission counter is charged and never given back. The
    // analysis slot is not: no collection and no model call ran.
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    await worker.fetch(submit("o/r"), env);
    const slotsAfterFirst = slotsOf(db);
    const submissionsAfterFirst = submissionsOf(db);

    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(submit("o/r"), env);
      expect(res.status, `cache hit ${i}`).toBe(303);
    }

    expect(slotsOf(db), "a cache hit costs no analysis").toBe(slotsAfterFirst);
    expect(submissionsOf(db), "but it did reach GitHub").toBe(submissionsAfterFirst + 20);
  });

  it("charges a name that resolves to nothing one submission and no analysis slot", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    for (let i = 0; i < 12; i++) {
      const res = await worker.fetch(submit(`nobody/repo-${i}`), env);
      expect(res.status, `attempt ${i}`).toBe(404);
    }

    expect(slotsOf(db)).toBe(0);
    expect(submissionsOf(db)).toBe(12);
  });

  it("still lets an ordinary visitor run five fresh analyses", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    for (let i = 0; i < 5; i++) {
      db.verdicts.clear();
      const res = await worker.fetch(submit("o/r"), env);
      expect(res.status, `analysis ${i}`).toBe(303);
    }

    expect(slotsOf(db)).toBe(5);

    db.verdicts.clear();
    const sixth = await worker.fetch(submit("o/r"), env);
    expect(sixth.status, "the sixth fresh analysis is the one that is refused").toBe(429);
  });
});

describe("an address whose analyses always fail", () => {
  it("runs the analysis limit plus the release allowance, then is refused", async () => {
    // The same bound the store states as arithmetic, seen through the HTTP
    // surface a visitor actually drives: every attempt collects, fails at
    // publication and gets its slot back, until the release allowance runs out
    // and a failure simply costs the slot. Nothing here is a retry a person
    // would notice; the point is that a script cannot turn 100 submissions
    // into 100 full collections.
    const db = fakeDb({ failVerdictWrites: true });
    const env = envWith(db);
    stubGithub();

    let collections = 0;
    let refusals = 0;
    for (let i = 0; i < 100; i++) {
      const res = await worker.fetch(submit("o/r"), env);
      if (res.status === 500) collections++;
      if (res.status === 429) refusals++;
    }

    expect(collections, "five analysis slots plus five releases").toBe(10);
    expect(refusals, "every later submission is refused before it collects").toBe(90);
  });
});

describe("a pasted URL a decoder cannot read", () => {
  it("is answered as an invalid target, not as a fault on our side", async () => {
    const env = envWith(fakeDb());
    stubGithub();

    const res = await worker.fetch(submit("https://github.com/o/%E0%A4%A"), env);
    expect(res.status, "the visitor pasted something broken, we did not break").toBe(400);

    const page = await worker.fetch(read("/r/github/o/%E0%A4%A"), env);
    expect(page.status).toBe(404);
  });
});

describe("an address past the submission ceiling", () => {
  it("is refused on the form but can still read reports that exist", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub();

    await worker.fetch(submit("o/r"), env);
    const upstreamAfterAnalysis = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    let refusals = 0;
    for (let i = 0; i < 120; i++) {
      const res = await worker.fetch(submit("o/r"), env);
      if (res.status === 429) refusals++;
    }
    expect(refusals, "the ceiling has to bite for this to test anything").toBeGreaterThan(0);

    const upstreamAfterReplay = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(
      upstreamAfterReplay - upstreamAfterAnalysis,
      "a refused submission reaches no upstream host",
    ).toBeLessThan(120 * 2);

    const page = await worker.fetch(read("/r/github/o/r/abc123"), env);
    expect(page.status, "reading an existing verdict is not rate limited").toBe(200);

    const json = await worker.fetch(read("/r/github/o/r/abc123?format=json"), env);
    expect(json.status).toBe(200);
  });
});
