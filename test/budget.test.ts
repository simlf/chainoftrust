import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/types";
import {
  estimateInputMicroCents,
  estimateWorstCaseMicroCents,
  rateFor,
  writeUp,
} from "../src/verdict/writeup";

const report: Report = {
  target: {
    cacheKey: "github:o/r@sha",
    host: "github",
    owner: "o",
    name: "r",
    requestedRef: "",
    sha: "sha",
    defaultBranch: "main",
  },
  verdict: "warnings",
  findings: [
    {
      check: "install-path",
      severity: "warning",
      concern: "install-path:verification-absent",
      statement: "install.sh downloads a file and never verifies it.",
      evidence: "install.sh:12",
      method: "file",
    },
  ],
  notChecked: ["Nothing was executed."],
  proseExcerpts: [],
  stats: {
    filesInTree: 10,
    totalBytes: 100,
    opaqueBytes: 0,
    filesFetched: 3,
    fetchBudgetExhausted: false,
  },
  generatedAt: "2026-08-10T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token rates behind the monthly ceiling", () => {
  it("prices the configured small model at its own rate", () => {
    expect(rateFor("claude-haiku-4-5")).toEqual({ input: 100, output: 500 });
  });

  it("prices a larger model higher, so the ceiling still holds after a config change", () => {
    const haiku = rateFor("claude-haiku-4-5");
    const sonnet = rateFor("claude-sonnet-5");
    const opus = rateFor("claude-opus-5");

    expect(sonnet.input).toBeGreaterThan(haiku.input);
    expect(opus.input).toBeGreaterThan(sonnet.input);
    expect(estimateWorstCaseMicroCents(report, opus)).toBeGreaterThan(
      estimateWorstCaseMicroCents(report, haiku),
    );
  });

  it("prices an unrecognised model at the most expensive rate it knows", () => {
    const unknown = rateFor("some-model-shipped-next-year");
    expect(unknown).toEqual(rateFor("claude-opus-5"));
    expect(unknown.input).toBeGreaterThanOrEqual(rateFor("claude-sonnet-5").input);
  });

  it("does not read claude-haiku-4-5 as the older, cheaper haiku", () => {
    expect(rateFor("claude-haiku-4-5").input).toBeGreaterThan(rateFor("claude-3-haiku").input);
  });

  it("prices a gateway spelling of a known model at that model's rate", () => {
    // OpenRouter writes versions with dots and prefixes the vendor.
    expect(rateFor("anthropic/claude-haiku-4.5")).toEqual(rateFor("claude-haiku-4-5"));
    expect(rateFor("meta-llama/llama-3.1-8b-instruct")).toEqual(rateFor("claude-opus-5"));
  });
});

describe("the budget guard", () => {
  it("degrades to a deterministic verdict with no key and spends nothing", async () => {
    const result = await writeUp(report, {
      model: "claude-haiku-4-5",
      budgetRemainingMicroCents: 1_000_000_000,
    });
    expect(result).toMatchObject({ text: null, microCents: 0, degradedReason: "no-key" });
  });

  it("degrades rather than calling the model once the ceiling is reached", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await writeUp(report, {
      provider: { kind: "anthropic", apiKey: "test-key" },
      model: "claude-haiku-4-5",
      budgetRemainingMicroCents: 1,
    });

    expect(result.degradedReason).toBe("budget");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const failWith = (status: number, body = "{}") =>
    vi.fn(async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );

  const attempt = () =>
    writeUp(report, {
      provider: { kind: "anthropic", apiKey: "test-key" },
      model: "claude-haiku-4-5",
      budgetRemainingMicroCents: 1_000_000_000,
    });

  it("charges the estimated input when a rate limit or a server error comes back", async () => {
    // These can arrive after the prompt was read, so the ledger stays
    // conservative. It charges input only: no output was produced.
    const inputOnly = estimateInputMicroCents(report, rateFor("claude-haiku-4-5"));

    vi.stubGlobal("fetch", failWith(429));
    const throttled = await attempt();
    expect(throttled).toMatchObject({ text: null, degradedReason: "error" });
    expect(throttled.microCents).toBe(inputOnly);

    vi.stubGlobal("fetch", failWith(503));
    expect((await attempt()).microCents).toBe(inputOnly);

    expect(inputOnly).toBeLessThan(
      estimateWorstCaseMicroCents(report, rateFor("claude-haiku-4-5")),
    );
  }, 60_000);

  it("charges nothing for a request the API rejected before inference", async () => {
    // A revoked key used to charge the worst case on every analysis. The ledger
    // never rolls back inside a month, so that locked the write-up off for the
    // rest of it, long after the key was fixed.
    for (const status of [400, 401, 403, 404]) {
      vi.stubGlobal("fetch", failWith(status));
      const result = await attempt();
      expect(result.degradedReason, String(status)).toBe("error");
      expect(result.microCents, String(status)).toBe(0);
    }
  }, 60_000);

  it("charges nothing when the request never reached the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));

    expect(await attempt()).toMatchObject({ microCents: 0, degradedReason: "error" });
  }, 60_000);
});
