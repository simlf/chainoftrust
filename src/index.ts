import { collect, resolveTarget, TargetNotFound } from "./collect";
import { readConfig, type Config, type Env } from "./env";
import { Fetcher } from "./lib/fetcher";
import { cacheKeyFor, InvalidTarget, parseTarget, registryQualifier } from "./lib/target";
import { hashIp, Store, utcDay } from "./store";
import type { StoredVerdict } from "./types";
import { homePage, messagePage, verdictPage, verdictPath } from "./ui/pages";
import { buildReport } from "./verdict/score";
import { writeUp } from "./verdict/writeup";

/** Bounded per analysis. A Worker that cannot loop cannot run up a bill. */
const FETCH_BUDGET = 34;
const MAX_FILE_BYTES = 256 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const url = new URL(request.url);
    const store = new Store(env.DB);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return homePage({ contact: config.contact });
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }

      if (request.method === "POST" && url.pathname === "/analyse") {
        return await handleAnalyse(request, store, config);
      }

      const verdict = matchVerdictPath(url.pathname);
      if (request.method === "GET" && verdict) {
        return await handleVerdictLookup(url, store, config, verdict);
      }

      return messagePage({
        title: "Not found - chainoftrust.dev",
        heading: "Nothing here",
        message: "That address does not correspond to a page or a report.",
        contact: config.contact,
        status: 404,
      });
    } catch {
      return messagePage({
        title: "Error - chainoftrust.dev",
        heading: "Something broke on our side",
        message:
          "The analysis did not complete. Nothing was published. Trying again in a moment is reasonable.",
        contact: config.contact,
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleAnalyse(
  request: Request,
  store: Store,
  config: Config,
): Promise<Response> {
  const form = await request.formData();
  const submitted = String(form.get("target") ?? "");

  let input;
  try {
    input = parseTarget(submitted);
  } catch (err) {
    if (err instanceof InvalidTarget) {
      return homePage({
        contact: config.contact,
        error: err.message,
        prefill: submitted,
        status: 400,
      });
    }
    throw err;
  }

  const fetcher = new Fetcher({
    budget: FETCH_BUDGET,
    maxBytesPerFile: MAX_FILE_BYTES,
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
  });

  let resolved;
  try {
    resolved = await resolveTarget(fetcher, input);
  } catch (err) {
    if (err instanceof TargetNotFound) {
      return homePage({
        contact: config.contact,
        error: err.message,
        prefill: submitted,
        status: 404,
      });
    }
    throw err;
  }

  // Cache by commit SHA. A hit is free, needs no model call, and deliberately
  // does not touch the rate limiter: punishing cache hits would discourage the
  // exact behaviour this product wants.
  const cached = await store.getVerdict(resolved.target.cacheKey);
  if (cached) {
    return redirect(verdictPath(cached.report));
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(ip, {
    day: utcDay(),
    ...(config.rateLimitSalt ? { secret: config.rateLimitSalt } : {}),
  });
  // Checked before the work, consumed after it. A collection or model failure
  // must not spend a slot on an analysis that produced nothing.
  const limit = await store.checkRateLimit(ipHash, config.ratePerDay);
  if (!limit.allowed) {
    return messagePage({
      title: "Daily limit reached - chainoftrust.dev",
      heading: "That is enough fresh analyses for today",
      message: `This address has run ${limit.limit} new analyses today, which is the limit. Reports that already exist stay free and unlimited, so anything analysed before is still available. The counter resets at midnight UTC.`,
      contact: config.contact,
      status: 429,
    });
  }

  const evidence = await collect(fetcher, resolved);
  const report = buildReport(evidence, new Date());

  const remaining = await store.budgetRemainingMicroCents(config.budgetCents);
  const summary = await writeUp(report, {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    model: config.modelId,
    budgetRemainingMicroCents: remaining,
  });
  await store.recordSpend(summary.microCents);

  await store.putVerdict(report, summary.text, summary.model);
  await store.consumeRateLimit(ipHash, config.ratePerDay);
  return redirect(verdictPath(report));
}

interface VerdictMatch {
  owner: string;
  name: string;
  sha?: string;
}

function matchVerdictPath(pathname: string): VerdictMatch | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // /r/github/:owner/:name[/:sha]  and the API alias
  const offset = parts[0] === "api" && parts[1] === "v1" && parts[2] === "verdict" ? 3 : 0;
  if (offset === 0 && parts[0] !== "r") return null;
  const base = offset === 0 ? 1 : offset;
  if (parts[base] !== "github") return null;

  const owner = parts[base + 1];
  const name = parts[base + 2];
  if (!owner || !name) return null;
  const sha = parts[base + 3];
  return sha ? { owner, name, sha } : { owner, name };
}

async function handleVerdictLookup(
  url: URL,
  store: Store,
  config: Config,
  match: VerdictMatch,
): Promise<Response> {
  const wantsJson =
    url.searchParams.get("format") === "json" || url.pathname.startsWith("/api/");

  // The path names a commit, not a cache row, and one commit can hold both a
  // bare repository report and a registry-qualified one. `?pkg=npm:name` picks
  // a specific row; without it the newest report for that commit is served.
  const stored: StoredVerdict | null = match.sha
    ? await lookupAtCommit(store, match.owner, match.name, match.sha, url.searchParams.get("pkg"))
    : await store.getLatestForRepo(match.owner, match.name);

  if (!stored) {
    if (wantsJson) {
      return json(
        {
          error: "not_analysed",
          message:
            "No report exists for this target yet. Reports are generated on request from the site.",
        },
        404,
      );
    }
    return messagePage({
      title: "No report yet - chainoftrust.dev",
      heading: "No report for that yet",
      message:
        "Nothing has been analysed at that address. Submit the repository from the front page and one will be generated.",
      contact: config.contact,
      status: 404,
    });
  }

  if (wantsJson) {
    return json(
      {
        verdict: stored.report.verdict,
        target: stored.report.target,
        summary: stored.writeup,
        summary_model: stored.writeupModel,
        findings: stored.report.findings,
        not_checked: stored.report.notChecked,
        prose_excerpts: stored.report.proseExcerpts,
        scorecard: stored.report.scorecard ?? null,
        stats: stored.report.stats,
        generated_at: stored.report.generatedAt,
      },
      200,
    );
  }

  return verdictPage(stored, config.contact);
}

async function lookupAtCommit(
  store: Store,
  owner: string,
  name: string,
  sha: string,
  pkg: string | null,
): Promise<StoredVerdict | null> {
  const registry = pkg ? registryQualifier(pkg) : null;
  if (registry) {
    const exact = await store.getVerdict(cacheKeyFor(owner, name, sha, registry));
    if (exact) return exact;
  }
  const plain = await store.getVerdict(cacheKeyFor(owner, name, sha));
  return plain ?? (await store.getVerdictAtCommit(owner, name, sha));
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Verdicts are public by design, so an agent can read one cross-origin.
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
    },
  });
}
