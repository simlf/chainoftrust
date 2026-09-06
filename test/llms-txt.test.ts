import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { LLMS_TXT } from "../src/llms-txt";

function envWith(db: unknown): Env {
  return {
    DB: db as never,
    MODEL_BUDGET_CENTS_PER_MONTH: "300",
    MODEL_ID: "claude-haiku-4-5",
    FRESH_ANALYSES_PER_IP_PER_DAY: "5",
    CONTACT_EMAIL: "hello@chainoftrust.dev",
  };
}

/** Answers every lookup with nothing on file: no repository has been analysed. */
function emptyDb() {
  return {
    prepare() {
      const stmt = {
        bind() {
          return stmt;
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
}

const REPORT_JSON = JSON.stringify({
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
});

/** Answers repo-latest and commit-pinned lookups for exactly one stored report. */
function dbWithOneReport() {
  return {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      const stmt = {
        bind() {
          return stmt;
        },
        async first() {
          if (text.includes("FROM verdicts")) {
            return {
              report_json: REPORT_JSON,
              writeup: null,
              writeup_model: null,
              writeup_degraded_reason: null,
              created_at: 0,
            };
          }
          return null;
        },
      };
      return stmt;
    },
  };
}

const get = (path: string, headers?: Record<string, string>) =>
  new Request(`https://chainoftrust.dev${path}`, { headers });

describe("GET /llms.txt", () => {
  it("serves the exported text as plain text, cacheable", async () => {
    const res = await worker.fetch(get("/llms.txt"), envWith(emptyDb()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toContain("public");
    expect(await res.text()).toBe(LLMS_TXT);
  });

  it("documents the JSON report endpoint, verdict tiers, and what is not checked", () => {
    expect(LLMS_TXT).toContain("/api/v1/verdict/github/:owner/:name");
    expect(LLMS_TXT).toContain("do-not-install");
    expect(LLMS_TXT).toContain("clean");
    expect(LLMS_TXT).toContain("warnings");
    expect(LLMS_TXT).toMatch(/not checked/i);
    expect(LLMS_TXT).toMatch(/vulnerability scanner/i);
    expect(LLMS_TXT).toMatch(/costs the site's operator real money/i);
    expect(LLMS_TXT).toMatch(/no mcp server/i);
  });

  it("contains no em dashes", () => {
    expect(LLMS_TXT).not.toContain("—");
  });
});

describe("JSON 404 for an unanalysed target", () => {
  it("carries a machine-usable hint: how to trigger analysis, and that it costs money", async () => {
    const res = await worker.fetch(get("/api/v1/verdict/github/nobody/nothing"), envWith(emptyDb()));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_analysed");
    expect(body.how_to_analyse).toMatch(/POST/);
    expect(body.how_to_analyse).toContain("/analyse");
    expect(body.note).toMatch(/costs the site operator real money/i);
    expect(body.note).toMatch(/prefer an existing report/i);
  });
});

describe("content negotiation on a report URL", () => {
  it("returns JSON when Accept: application/json is sent, with no query param or /api/ path", async () => {
    const res = await worker.fetch(
      get("/r/github/o/r", { accept: "application/json" }),
      envWith(dbWithOneReport()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verdict).toBe("warnings");
  });

  it("still returns HTML for an ordinary browser Accept header", async () => {
    const res = await worker.fetch(
      get("/r/github/o/r", {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }),
      envWith(dbWithOneReport()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("still returns HTML with no Accept header at all", async () => {
    const res = await worker.fetch(get("/r/github/o/r"), envWith(dbWithOneReport()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
