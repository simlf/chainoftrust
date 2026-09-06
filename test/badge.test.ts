import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { Report, Verdict } from "../src/types";
import { badgeSvg } from "../src/ui/badge";

function report(overrides: Partial<Report> = {}): Report {
  return {
    target: {
      cacheKey: "k",
      host: "github",
      owner: "o",
      name: "r",
      requestedRef: "",
      sha: "abc123",
      defaultBranch: "main",
    },
    verdict: "warnings",
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
    ...overrides,
  };
}

const TIER_COLOR: Record<Verdict, string> = {
  clean: "#9ff0c8",
  warnings: "#ffd27a",
  "do-not-install": "#ff9d8a",
};

describe("badgeSvg, fixture-driven per tier", () => {
  it("is a valid standalone SVG naming the product and the verdict word for every tier", () => {
    for (const verdict of Object.keys(TIER_COLOR) as Verdict[]) {
      const svg = badgeSvg({ verdict, href: "/r/github/o/r/abc123" });
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), verdict).toBe(true);
      expect(svg, verdict).toContain("</svg>");
      expect(svg, verdict).toContain("chainoftrust");
      expect(svg, verdict).toContain(verdict === "do-not-install" ? "do not install" : verdict);
      expect(svg, verdict).toContain('href="/r/github/o/r/abc123"');
      expect(svg, verdict).toContain(TIER_COLOR[verdict]);
    }
  });

  it("gives every tier a distinct colour, matching the report stamp's own tokens", () => {
    const colors = (Object.keys(TIER_COLOR) as Verdict[]).map(
      (verdict) => badgeSvg({ verdict, href: "/" }).match(/#[0-9a-f]{6}/g) ?? [],
    );
    // Each tier's fill should not appear in the two other tiers' output.
    const [clean, warnings, doNotInstall] = colors;
    expect(clean).not.toEqual(warnings);
    expect(warnings).not.toEqual(doNotInstall);
    expect(clean).not.toEqual(doNotInstall);
  });

  it("answers honestly, and visibly differently, when there is no report yet", () => {
    const svg = badgeSvg({ href: "/" });
    expect(svg).toContain("not analyzed");
    for (const color of Object.values(TIER_COLOR)) {
      expect(svg).not.toContain(color);
    }
  });

  it("escapes the link target, since it is never a repository owner or name the target controls", () => {
    const svg = badgeSvg({ href: '/"><script>alert(1)</script>' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

/**
 * A stand-in for the D1 statements the badge route can issue. Modelling only
 * the one read `getLatestForRepo` makes and nothing else means any other
 * query (a rate-limit consume, a submission counter, a verdict write) throws
 * "unmodelled statement" and fails the test loudly, which is what makes the
 * no-spend tests below a behavioural proof rather than an assertion about
 * intent.
 */
function fakeDb() {
  const verdicts: { owner: string; name: string; report_json: string; created_at: number }[] = [];
  let seq = 0;
  return {
    seed(owner: string, name: string, r: Report) {
      verdicts.push({ owner, name, report_json: JSON.stringify(r), created_at: seq++ });
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
          if (
            text.includes("FROM verdicts") &&
            text.includes("WHERE host = 'github' AND owner = ? AND name = ?") &&
            !text.includes("AND ref = ?")
          ) {
            const [owner, name] = args as [string, string];
            const matches = verdicts
              .filter((r) => r.owner === owner && r.name === name)
              .sort((a, b) => b.created_at - a.created_at);
            const row = matches[0];
            return row
              ? ({
                  report_json: row.report_json,
                  writeup: null,
                  writeup_model: null,
                  writeup_degraded_reason: null,
                  created_at: row.created_at,
                } as T)
              : null;
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };
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

const read = (path: string) => new Request(`https://chainoftrust.dev${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /badge/github/:owner/:name.svg", () => {
  it("answers honestly, at zero cost, for a repository with no report yet", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = envWith(fakeDb());

    const res = await worker.fetch(read("/badge/github/nobody/repo.svg"), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.text()).toContain("not analyzed");
    expect(fetchSpy, "a badge read never reaches an upstream host").not.toHaveBeenCalled();
  });

  it("never triggers an analysis, however many times a bare README embed is fetched", async () => {
    // The no-spend guarantee proven behaviourally: the fake DB throws on any
    // query outside the one read this route is allowed, so if a badge view
    // ever consumed a submission or an analysis slot, this test would fail on
    // the first request, not just the hundredth.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = envWith(fakeDb());

    for (let i = 0; i < 50; i++) {
      const res = await worker.fetch(read("/badge/github/nobody/repo.svg"), env);
      expect(res.status, `request ${i}`).toBe(200);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reflects the stored verdict tier and links to that report", async () => {
    const db = fakeDb();
    db.seed("o", "r", report({ verdict: "do-not-install" }));
    const env = envWith(db);

    const res = await worker.fetch(read("/badge/github/o/r.svg"), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await res.text();
    expect(body).toContain("do not install");
    expect(body).toContain("#ff9d8a");
    expect(body).toContain('href="/r/github/o/r/abc123"');
  });

  it("is case-insensitive on the repository, like every other report route", async () => {
    const db = fakeDb();
    db.seed("o", "r", report({ verdict: "clean" }));
    const env = envWith(db);

    const res = await worker.fetch(read("/badge/github/O/R.svg"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("clean");
  });

  it("404s on a path missing the .svg suffix or a name, rather than guessing", async () => {
    const env = envWith(fakeDb());
    expect((await worker.fetch(read("/badge/github/o/r"), env)).status).toBe(404);
    expect((await worker.fetch(read("/badge/github/o"), env)).status).toBe(404);
    expect((await worker.fetch(read("/badge/gitlab/o/r.svg"), env)).status).toBe(404);
  });
});
