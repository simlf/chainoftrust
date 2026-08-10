import { afterEach, describe, expect, it, vi } from "vitest";
import { Fetcher } from "../src/lib/fetcher";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch() {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("ok", { status: 200, headers: { "content-length": "2" } });
  }) as typeof fetch;
  return calls;
}

const make = () => new Fetcher({ budget: 3, maxBytesPerFile: 1024 });

/**
 * The fetcher is the sandbox boundary, so its refusals are the security tests.
 */
describe("egress allowlist", () => {
  it("refuses every host that is not on the list", async () => {
    const calls = stubFetch();
    const f = make();
    for (const url of [
      "https://evil.test/payload",
      "https://raw.githubusercontent.com.evil.test/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/admin",
      "https://api.github.com.evil.test/repos/o/r",
    ]) {
      expect(await f.text(url), url).toBeNull();
    }
    expect(calls).toEqual([]);
    // A refusal must not consume budget, or a hostile README could exhaust it.
    expect(f.used).toBe(0);
  });

  it("refuses non-https schemes", async () => {
    const calls = stubFetch();
    const f = make();
    expect(await f.text("http://api.github.com/repos/o/r")).toBeNull();
    expect(await f.text("file:///etc/passwd")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("allows the five hosts the analysis actually needs", async () => {
    const calls = stubFetch();
    const f = new Fetcher({ budget: 10, maxBytesPerFile: 1024 });
    for (const url of [
      "https://api.github.com/repos/o/r",
      "https://raw.githubusercontent.com/o/r/sha/README.md",
      "https://registry.npmjs.org/left-pad",
      "https://pypi.org/pypi/requests/json",
      "https://api.securityscorecards.dev/projects/github.com/o/r",
    ]) {
      await f.text(url);
    }
    expect(calls).toHaveLength(5);
  });

  it("never follows a redirect off the allowlist", async () => {
    stubFetch();
    const f = make();
    await f.text("https://api.github.com/repos/o/r");
    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(init.redirect).toBe("manual");
  });
});

describe("fetch budget", () => {
  it("stops once the budget is spent and says so", async () => {
    const calls = stubFetch();
    const f = make();
    for (let i = 0; i < 6; i++) await f.text(`https://api.github.com/x/${i}`);
    expect(calls).toHaveLength(3);
    expect(f.budgetExhausted).toBe(true);
    expect(f.remaining).toBe(0);
  });
});

describe("file size cap", () => {
  it("refuses a file larger than the cap", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("x".repeat(5000), {
          status: 200,
          headers: { "content-length": "5000" },
        }),
    ) as typeof fetch;
    const f = new Fetcher({ budget: 5, maxBytesPerFile: 1024 });
    expect(await f.text("https://raw.githubusercontent.com/o/r/s/big.js")).toBeNull();
  });

  it("refuses a file that lies about its length", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("x".repeat(5000), {
          status: 200,
          headers: { "content-length": "10" },
        }),
    ) as typeof fetch;
    const f = new Fetcher({ budget: 5, maxBytesPerFile: 1024 });
    expect(await f.text("https://raw.githubusercontent.com/o/r/s/big.js")).toBeNull();
  });
});

describe("credentials", () => {
  it("sends the GitHub token to GitHub and to nowhere else", async () => {
    stubFetch();
    const f = new Fetcher({
      budget: 5,
      maxBytesPerFile: 1024,
      githubToken: "secret-token",
    });
    await f.text("https://api.github.com/repos/o/r");
    await f.text("https://registry.npmjs.org/left-pad");
    await f.text("https://raw.githubusercontent.com/o/r/s/README.md");

    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const headersFor = (i: number) => mock.mock.calls[i]![1].headers as Record<string, string>;
    expect(headersFor(0).authorization).toBe("Bearer secret-token");
    expect(headersFor(1).authorization).toBeUndefined();
    expect(headersFor(2).authorization).toBeUndefined();
  });
});
