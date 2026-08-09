import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/types";
import { estimateWorstCaseMicroCents, rateFor, writeUp } from "../src/verdict/writeup";

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
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      budgetRemainingMicroCents: 1,
    });

    expect(result.degradedReason).toBe("budget");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("charges the worst-case estimate when the call fails", async () => {
    // A call can fail after tokens were consumed. Recording zero would let a
    // sustained error rate walk straight past the monthly ceiling.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("upstream is down");
    }));

    const result = await writeUp(report, {
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      budgetRemainingMicroCents: 1_000_000_000,
    });

    expect(result.degradedReason).toBe("error");
    expect(result.text).toBeNull();
    expect(result.microCents).toBe(
      estimateWorstCaseMicroCents(report, rateFor("claude-haiku-4-5")),
    );
  }, 30_000);
});
