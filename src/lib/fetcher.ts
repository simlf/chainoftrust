/**
 * The only way this Worker talks to the network.
 *
 * Sandbox rules (DRAFT.md, "Sandbox and isolation - non-negotiable"):
 *
 *  1. Target repository content is never executed. A Worker has no shell, no
 *     filesystem and no process spawning, so this is structural rather than a
 *     policy we have to remember to enforce.
 *  2. Nothing is cloned and no archive is extracted. Files are read one at a
 *     time over HTTPS into memory. A repository therefore cannot register a
 *     skill, a hook or an MCP server into anything, which is the auto-discovery
 *     hazard the validation report found firing three times out of eight.
 *  3. Egress is allowlisted. A README that says "fetch this URL" cannot make us
 *     fetch it, and the target cannot use us to reach an internal address.
 *  4. Every read is bounded: a fetch budget, a per-file byte cap, and no
 *     redirects off the allowlist.
 */

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "api.securityscorecards.dev",
]);

export class FetchBudgetExhausted extends Error {
  constructor() {
    super("fetch budget exhausted");
  }
}

export interface FetcherOptions {
  /** Hard cap on network calls for one analysis. */
  budget: number;
  /** Hard cap on the bytes read from any single file. */
  maxBytesPerFile: number;
  githubToken?: string;
}

export class Fetcher {
  #used = 0;
  #exhausted = false;
  readonly #opts: FetcherOptions;

  constructor(opts: FetcherOptions) {
    this.#opts = opts;
  }

  get used(): number {
    return this.#used;
  }

  /** True once a call was refused because the budget ran out. */
  get budgetExhausted(): boolean {
    return this.#exhausted;
  }

  get remaining(): number {
    return Math.max(0, this.#opts.budget - this.#used);
  }

  async json<T>(url: string): Promise<T | null> {
    const res = await this.#request(url, "application/vnd.github+json");
    if (!res || !res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /**
   * Read a file as text. Returns null when absent, over the size cap, or when
   * the budget is gone. Callers must treat the result as untrusted data.
   */
  async text(url: string): Promise<string | null> {
    const res = await this.#request(url, "text/plain");
    if (!res || !res.ok) return null;

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.#opts.maxBytesPerFile) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.#opts.maxBytesPerFile) return null;
    return new TextDecoder().decode(buf);
  }

  async #request(url: string, accept: string): Promise<Response | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.protocol !== "https:") return null;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;

    if (this.#used >= this.#opts.budget) {
      this.#exhausted = true;
      return null;
    }
    this.#used++;

    const headers: Record<string, string> = {
      accept,
      "user-agent": "chainoftrust.dev (+https://chainoftrust.dev)",
    };
    if (parsed.hostname === "api.github.com" && this.#opts.githubToken) {
      headers.authorization = `Bearer ${this.#opts.githubToken}`;
    }

    try {
      // `redirect: manual` keeps a redirect from carrying us off the allowlist.
      // GitHub's raw host serves content directly, so this costs nothing real.
      return await fetch(parsed.toString(), { headers, redirect: "manual" });
    } catch {
      return null;
    }
  }
}
