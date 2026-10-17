import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker, { MIN_REANALYSIS_INTERVAL_MS } from "../src/index";
import { ANALYSER_VERSION } from "../src/verdict/version";

/**
 * A stand-in for the D1 statements the Worker issues on the submit and lookup
 * paths, rich enough to answer "the most recent report for this repository"
 * as well as an exact cache-key lookup. Anything it does not model throws, so
 * a query this fake does not cover cannot pass silently.
 */
function fakeDb() {
  const counters = new Map<string, number>();
  const verdicts = new Map<
    string,
    { report_json: string; owner: string; name: string; created_at: number }
  >();

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
          if (text.startsWith("UPDATE rate_limits SET count = count - 1")) return;
          if (text.startsWith("INSERT INTO verdicts")) {
            verdicts.set(String(args[0]), {
              report_json: String(args[6]),
              owner: String(args[2]),
              name: String(args[3]),
              created_at: Date.now(),
            });
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
            const row = verdicts.get(String(args[0]));
            return row ? toRow(row) : null;
          }
          if (
            text.includes("FROM verdicts") &&
            text.includes("WHERE host = 'github' AND owner = ? AND name = ?") &&
            !text.includes("AND ref = ?")
          ) {
            const [owner, name] = args as [string, string];
            const matches = [...verdicts.values()]
              .filter((r) => r.owner === owner && r.name === name)
              .sort((a, b) => b.created_at - a.created_at);
            return matches[0] ? toRow(matches[0]) : null;
          }
          if (text.startsWith("SELECT micro_cents FROM model_spend")) return null;
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };

  function toRow<T>(row: { report_json: string; created_at: number }): T {
    return {
      report_json: row.report_json,
      writeup: null,
      writeup_model: null,
      writeup_degraded_reason: null,
      created_at: row.created_at,
    } as T;
  }
}

const slotsOf = (db: ReturnType<typeof fakeDb>) =>
  [...db.counters.entries()]
    .filter(([key]) => !key.startsWith("resolve:"))
    .map(([, count]) => count)
    .reduce((a, b) => a + b, 0);

/** GitHub responses for a repo whose default-branch head can be moved between requests. */
function stubGithub(head: { sha: string }) {
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
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.github.com/repos/o/r") {
      return new Response(JSON.stringify(REPO), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/o/r/commits/main") {
      return new Response(JSON.stringify({ sha: head.sha }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Any commit endpoint hit with an explicit ref resolves to that ref
    // itself, matching how a pasted commit URL pins to a real sha.
    const commitMatch = /^https:\/\/api\.github\.com\/repos\/o\/r\/commits\/(.+)$/.exec(url);
    if (commitMatch) {
      return new Response(JSON.stringify({ sha: commitMatch[1] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://openrouter.test/v1/chat/completions") {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Fine." } }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function envWith(db: ReturnType<typeof fakeDb>): Env {
  return {
    DB: db as never,
    MODEL_BUDGET_CENTS_PER_MONTH: "300",
    MODEL_ID: "claude-haiku-4-5",
    FRESH_ANALYSES_PER_IP_PER_DAY: "50",
    CONTACT_EMAIL: "hello@chainoftrust.dev",
  };
}

function envWithProvider(db: ReturnType<typeof fakeDb>): Env {
  return {
    ...envWith(db),
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE_URL: "https://openrouter.test/v1",
  };
}

const submit = (target: string, refresh?: string) =>
  new Request("https://chainoftrust.dev/analyse", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7" },
    body: new URLSearchParams({ target, ...(refresh ? { refresh } : {}) }),
  });

const read = (path: string) => new Request(`https://chainoftrust.dev${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the same commit is never analysed twice", () => {
  it("serves the exact-sha cache with zero collector fetches and zero model calls", async () => {
    // A provider is configured on purpose: this proves the second and later
    // requests neither collect nor call it, not merely that there is nothing
    // configured to call.
    const db = fakeDb();
    const env = envWithProvider(db);
    const head = { sha: "aaa111" };
    const fetchSpy = stubGithub(head);

    const first = await worker.fetch(submit("o/r"), env);
    expect(first.status).toBe(303);
    const callsAfterFirst = fetchSpy.mock.calls.length;
    const providerCallsAfterFirst = fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("openrouter"),
    ).length;
    expect(providerCallsAfterFirst, "the first, real analysis did call the provider").toBe(1);
    const slotsAfterFirst = slotsOf(db);

    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(submit("o/r"), env);
      expect(res.status, `repeat ${i}`).toBe(303);
    }

    // Resolving still reaches GitHub twice per submission (repo + head ref),
    // because a submission always pays for that lookup. Nothing past it ran:
    // no tree, no file reads, no release, no scorecard, and no model call.
    expect(fetchSpy.mock.calls.length, "no upstream calls beyond resolving").toBe(
      callsAfterFirst + 10 * 2,
    );
    expect(
      fetchSpy.mock.calls.filter(([u]) => String(u).includes("openrouter")).length,
      "no further calls reached the summary provider",
    ).toBe(providerCallsAfterFirst);
    expect(slotsOf(db), "a cache hit spends no analysis slot").toBe(slotsAfterFirst);
  });
});

describe("a new head commit on an already-analysed repository", () => {
  it("serves the existing report by default instead of analysing silently", async () => {
    const db = fakeDb();
    const env = envWith(db);
    const head = { sha: "aaa111" };
    stubGithub(head);

    await worker.fetch(submit("o/r"), env);
    const slotsAfterFirst = slotsOf(db);

    head.sha = "bbb222";
    const res = await worker.fetch(submit("o/r"), env);

    expect(res.status, "pasting the same URL again is not a fresh analysis").toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/r/github/o/r/aaa111");
    expect(location).toContain("newer=bbb222");
    expect(slotsOf(db), "no analysis slot was spent serving the stale report").toBe(
      slotsAfterFirst,
    );
  });

  it("shows a visible newer-commit notice with an explicit refresh action", async () => {
    const db = fakeDb();
    const env = envWith(db);
    const head = { sha: "aaa111" };
    stubGithub(head);

    await worker.fetch(submit("o/r"), env);
    head.sha = "bbb222";
    await worker.fetch(submit("o/r"), env);

    const page = await worker.fetch(read("/r/github/o/r/aaa111?newer=bbb222"), env);
    const body = await page.text();

    expect(body).toContain("moved to a newer commit");
    expect(body).toContain("bbb222");
    expect(body).toContain('name="refresh" value="1"');
    expect(body).toContain('name="target" value="o/r"');
  });

  it("does not show the newer-commit notice for a report that is not stale", async () => {
    const db = fakeDb();
    const env = envWith(db);
    stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    // A visitor-supplied "newer" naming the report's own commit is not honest
    // to show as a stale banner, so it must be dropped.
    const page = await worker.fetch(read("/r/github/o/r/aaa111?newer=aaa111"), env);
    const body = await page.text();

    expect(body).not.toContain("moved to a newer commit");
  });

  it("refuses an explicit refresh requested too soon after the last analysis", async () => {
    const db = fakeDb();
    const env = envWith(db);
    const head = { sha: "aaa111" };
    stubGithub(head);

    await worker.fetch(submit("o/r"), env);
    const slotsAfterFirst = slotsOf(db);

    head.sha = "bbb222";
    const refreshed = await worker.fetch(submit("o/r", "1"), env);

    expect(refreshed.status, "the floor bites before any collection runs").toBe(429);
    const body = await refreshed.text();
    expect(body).toContain("too recently");
    expect(slotsOf(db), "no analysis slot was spent on a refused refresh").toBe(slotsAfterFirst);
  });

  it("allows an explicit refresh once the minimum interval has passed", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const env = envWith(db);
    const head = { sha: "aaa111" };
    stubGithub(head);

    await worker.fetch(submit("o/r"), env);
    const slotsAfterFirst = slotsOf(db);

    head.sha = "bbb222";
    vi.advanceTimersByTime(MIN_REANALYSIS_INTERVAL_MS + 1000);

    const res = await worker.fetch(submit("o/r", "1"), env);

    expect(res.status, "a deliberate refresh past the floor runs a fresh analysis").toBe(303);
    expect(res.headers.get("location")).toContain("/r/github/o/r/bbb222");
    expect(slotsOf(db), "the deliberate refresh spent one analysis slot").toBe(
      slotsAfterFirst + 1,
    );
  });

  it("does not gate an explicit commit or ref pasted by the visitor", async () => {
    // Pasting a specific commit URL is already the deliberate act; it must not
    // be redirected back to the existing report for a different commit.
    const db = fakeDb();
    const env = envWith(db);
    stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    const slotsAfterFirst = slotsOf(db);

    const res = await worker.fetch(submit("https://github.com/o/r/commit/deadbeef"), env);

    expect(res.status, "an explicit pin always analyses, never the stale-gate redirect").toBe(
      303,
    );
    expect(res.headers.get("location")).toContain("/r/github/o/r/deadbeef");
    expect(slotsOf(db)).toBe(slotsAfterFirst + 1);
  });
});

describe("a stored report produced by older checks, or past its maximum age", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Rewrite the stored row as if an earlier deploy's checks had written it. */
  function markOlderChecks(db: ReturnType<typeof fakeDb>, version?: number) {
    for (const row of db.verdicts.values()) {
      const report = JSON.parse(row.report_json) as Record<string, unknown>;
      if (version === undefined) delete report.analyserVersion;
      else report.analyserVersion = version;
      row.report_json = JSON.stringify(report);
    }
  }

  it("serves a report from the current checks without recomputing it", async () => {
    const db = fakeDb();
    const env = envWithProvider(db);
    const fetchSpy = stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    const stored = JSON.parse([...db.verdicts.values()][0]!.report_json);
    expect(stored.analyserVersion, "a fresh report is stamped").toBe(ANALYSER_VERSION);
    const slots = slotsOf(db);
    const calls = fetchSpy.mock.calls.length;

    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(303);
    expect(slotsOf(db), "a current hit spends no analysis").toBe(slots);
    expect(fetchSpy.mock.calls.length, "only the two resolving calls").toBe(calls + 2);
  });

  it.each([
    ["with no version at all, as every report stored before the stamp", undefined],
    ["with an older version", ANALYSER_VERSION - 1],
  ])("recomputes a report %s, then serves the recomputation", async (_label, version) => {
    const db = fakeDb();
    const env = envWithProvider(db);
    const fetchSpy = stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    markOlderChecks(db, version);
    const slots = slotsOf(db);
    const providerCalls = () =>
      fetchSpy.mock.calls.filter(([u]) => String(u).includes("openrouter")).length;
    const providerBefore = providerCalls();

    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/r/github/o/r/aaa111");
    expect(slotsOf(db), "the recomputation is a fresh analysis, charged as one").toBe(
      slots + 1,
    );
    expect(providerCalls(), "and gets a fresh summary").toBe(providerBefore + 1);
    expect(db.verdicts.size, "it replaces the old row rather than adding one").toBe(1);
    const replaced = JSON.parse([...db.verdicts.values()][0]!.report_json);
    expect(replaced.analyserVersion).toBe(ANALYSER_VERSION);

    // One visitor cannot turn one stale report into repeated runs: the
    // recomputation is current, so every later submission is a plain hit.
    for (let i = 0; i < 10; i++) await worker.fetch(submit("o/r"), env);
    expect(slotsOf(db)).toBe(slots + 1);
    expect(providerCalls()).toBe(providerBefore + 1);
  });

  it("recomputes a report past the maximum age, and not one inside it", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const env = envWith(db);
    stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    const slots = slotsOf(db);

    vi.advanceTimersByTime(29 * DAY);
    await worker.fetch(submit("o/r"), env);
    expect(slotsOf(db), "29 days old is inside the default 30").toBe(slots);

    vi.advanceTimersByTime(2 * DAY);
    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(303);
    expect(slotsOf(db), "31 days old is recomputed").toBe(slots + 1);

    // The recomputation restarted the row's age, so the next one is a hit.
    await worker.fetch(submit("o/r"), env);
    expect(slotsOf(db)).toBe(slots + 1);
  });

  it("honours a configured maximum age", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const env = { ...envWith(db), REPORT_MAX_AGE_DAYS: "2" };
    stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    const slots = slotsOf(db);
    vi.advanceTimersByTime(3 * DAY);
    await worker.fetch(submit("o/r"), env);
    expect(slotsOf(db)).toBe(slots + 1);
  });

  it("refuses a stale recomputation once the visitor's fresh analyses are spent", async () => {
    // A recomputation is a fresh analysis, so the per-address limit applies
    // to it exactly as it does to a first analysis.
    const db = fakeDb();
    const env = { ...envWith(db), FRESH_ANALYSES_PER_IP_PER_DAY: "1" };
    stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    markOlderChecks(db);

    const res = await worker.fetch(submit("o/r"), env);
    expect(res.status).toBe(429);
    const stored = JSON.parse([...db.verdicts.values()][0]!.report_json);
    expect(stored.analyserVersion, "nothing was recomputed").toBeUndefined();
  });

  it("marks a stale report as such when read, and recomputes nothing on a read", async () => {
    const db = fakeDb();
    const env = envWith(db);
    const fetchSpy = stubGithub({ sha: "aaa111" });

    await worker.fetch(submit("o/r"), env);
    markOlderChecks(db);
    const slots = slotsOf(db);
    const calls = fetchSpy.mock.calls.length;

    const page = await worker.fetch(read("/r/github/o/r/aaa111"), env);
    expect(page.status, "reading is never refused").toBe(200);
    expect(page.headers.get("cache-control"), "and a stale page is not cacheable").toBeNull();
    const body = await page.text();
    expect(body).toContain("earlier version of the checks");
    expect(body).toContain('name="target" value="https://github.com/o/r/tree/aaa111"');

    const api = await worker.fetch(read("/api/v1/verdict/github/o/r/aaa111"), env);
    expect(api.headers.get("cache-control")).toBe("no-store");
    const payload = (await api.json()) as Record<string, unknown>;
    expect(payload.outdated).toBe("outdated-checks");
    expect(payload.analyser_version).toBe(0);
    expect(payload.current_analyser_version).toBe(ANALYSER_VERSION);

    expect(slotsOf(db)).toBe(slots);
    expect(fetchSpy.mock.calls.length, "a read reaches nothing upstream").toBe(calls);

    // The page's own recompute form lands on the same row and recomputes it.
    const recomputed = await worker.fetch(submit("https://github.com/o/r/tree/aaa111"), env);
    expect(recomputed.headers.get("location")).toContain("/r/github/o/r/aaa111");
    expect(slotsOf(db)).toBe(slots + 1);
    const fresh = await worker.fetch(read("/api/v1/verdict/github/o/r/aaa111"), env);
    expect(((await fresh.json()) as Record<string, unknown>).outdated).toBeNull();
  });
});
