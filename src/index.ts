import { collect, resolveTarget, TargetNotFound } from "./collect";
import { readConfig, type Config, type Env } from "./env";
import { Fetcher } from "./lib/fetcher";
import { decodeSegments, InvalidTarget, parseTarget } from "./lib/target";
import { hashIp, Store, utcDay, type RateLimitResult } from "./store";
import type { Report, StoredVerdict } from "./types";
import { badgeSvg } from "./ui/badge";
import { homePage, messagePage, verdictPage, verdictPath } from "./ui/pages";
import { buildReport } from "./verdict/score";
import { writeUp } from "./verdict/writeup";

/** Bounded per analysis. A Worker that cannot loop cannot run up a bill. */
const FETCH_BUDGET = 34;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Submissions per address per UTC day. Every one of them resolves a target,
 * which always reaches upstream, so this is what bounds the work an address can
 * drive. Sized to stop a scripted replay, not to ration a person looking things
 * up: a reader who never runs a fresh analysis still gets a hundred lookups.
 */
const SUBMISSIONS_PER_DAY = 100;

/**
 * Floor on how often one repository can be freshly re-analysed.
 *
 * Only bites the deliberate-refresh path (see handleAnalyse): a bare repository
 * or package submission with a report already on file is served that report by
 * default, not re-run, however many times the same URL is pasted. This is what
 * stops a visitor who does ask for a refresh from turning a busy repository's
 * traffic into unbounded fresh collections. It composes with the per-IP
 * analysis and submission counters rather than replacing them; both still
 * apply once this floor is cleared.
 */
export const MIN_REANALYSIS_INTERVAL_MS = 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const url = new URL(request.url);

    if (url.hostname !== "chainoftrust.dev" && url.hostname.endsWith(".chainoftrust.dev")) {
      url.hostname = "chainoftrust.dev";
      return Response.redirect(url.toString(), 301);
    }

    if (url.hostname.endsWith(".workers.dev")) {
      url.hostname = "chainoftrust.dev";
      return Response.redirect(url.toString(), 301);
    }

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

      const badge = matchBadgePath(url.pathname);
      if (request.method === "GET" && badge) {
        return await handleBadge(store, badge);
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
        path: url.pathname,
      });
    } catch {
      return messagePage({
        title: "Error - chainoftrust.dev",
        heading: "Something broke on our side",
        message:
          "The analysis did not complete. Nothing was published. Trying again in a moment is reasonable.",
        contact: config.contact,
        status: 500,
        path: url.pathname,
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

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(ip, {
    day: utcDay(),
    ...(config.rateLimitSalt ? { secret: config.rateLimitSalt } : {}),
  });

  // Two counters, two jobs. Resolving a target always reaches upstream, so
  // every submission spends one submission unit and never gets it back, cached
  // or not. A fresh analysis is the expensive part, so it spends one of the
  // five analysis slots, and only when there is really an analysis to run.
  const submission = await store.consumeSubmission(ipHash, SUBMISSIONS_PER_DAY);
  if (!submission.allowed) return submissionsRefusedPage(submission, config);

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

  // Cache by commit SHA. A hit needs no collection and no model call, so it
  // costs no analysis slot however many times it is asked for.
  const cached = await store.getVerdict(resolved.target.cacheKey);
  if (cached) return redirect(verdictPath(cached.report));

  // A submission that named no explicit ref or commit tracks the repository's
  // moving head, so pasting the same URL twice can resolve to a new commit
  // with nothing the visitor did to ask for a fresh analysis. If one already
  // exists for this repository, serving it is the default; re-analysing it is
  // a deliberate act (the "refresh" field), gated by the interval above so
  // that deliberate act cannot itself be hammered. An explicit ref or commit in
  // the input is already the deliberate act, and skips this gate entirely.
  if (resolved.target.requestedRef === "") {
    const latest = await store.getLatestForRepo(resolved.target.owner, resolved.target.name);
    if (latest && latest.report.target.sha !== resolved.target.sha) {
      const refreshRequested = String(form.get("refresh") ?? "") === "1";
      if (!refreshRequested) {
        return redirect(stalePath(latest.report, resolved.target.sha));
      }
      const wait = MIN_REANALYSIS_INTERVAL_MS - (Date.now() - latest.createdAt);
      if (wait > 0) return reanalysisTooSoonPage(latest.report.target.sha, wait, config);
    }
  }

  const limit = await store.consumeRateLimit(ipHash, config.ratePerDay);
  if (!limit.allowed) return refusedPage(limit, config);

  try {
    const evidence = await collect(fetcher, resolved);
    const report = buildReport(evidence, new Date());

    const remaining = await store.budgetRemainingMicroCents(config.budgetCents);
    const summary = await writeUp(report, {
      ...(config.provider ? { provider: config.provider } : {}),
      model: config.modelId,
      ...(config.modelRate ? { rate: config.modelRate } : {}),
      budgetRemainingMicroCents: remaining,
    });
    await store.recordSpend(summary.microCents);

    await store.putVerdict(report, summary.text, summary.model, summary.degradedReason);
    return redirect(verdictPath(report));
  } catch (err) {
    // The analysis produced nothing, so the slot goes back, up to the daily
    // allowance the release path enforces itself. Past that a failure costs the
    // slot, which is what bounds a target that fails on every attempt.
    await store.releaseRateLimit(ipHash);
    throw err;
  }
}

/**
 * A refusal the counter could not confirm is still a refusal, but saying the
 * visitor spent a quota they may not have spent would be a false statement on
 * the error page of a product whose claim is verifiable facts.
 */
function refusedPage(limit: RateLimitResult, config: Config): Response {
  if (limit.reason === "unavailable") return storageFaultPage(config, "fresh analyses");
  return messagePage({
    title: "Daily limit reached - chainoftrust.dev",
    heading: "That is enough fresh analyses for today",
    message: `This address has run ${limit.limit} new analyses today, which is the limit. A report that already exists costs no analysis, and reading one at its own address costs nothing at all, so anything analysed before is still available. The counter resets at midnight UTC.`,
    contact: config.contact,
    status: 429,
  });
}

function submissionsRefusedPage(limit: RateLimitResult, config: Config): Response {
  if (limit.reason === "unavailable") return storageFaultPage(config, "submissions");
  return messagePage({
    title: "Too many submissions today - chainoftrust.dev",
    heading: "That is enough submissions from this address today",
    message: `This address has sent ${limit.limit} submissions today, which is the limit. Every submission looks the target up at GitHub or a registry before anything else happens, so that is what the limit counts. Reports that already exist stay readable at their own addresses, and reading one costs nothing. The counter resets at midnight UTC.`,
    contact: config.contact,
    status: 429,
  });
}

/**
 * Names the counter that actually refused, because two callers reach here and
 * the page of a product whose standard is verifiable facts should not blame the
 * counter that read fine.
 */
function storageFaultPage(config: Config, counter: "submissions" | "fresh analyses"): Response {
  return messagePage({
    title: "Try again shortly - chainoftrust.dev",
    heading: "We could not start a fresh analysis",
    message: `The counter that tracks ${counter} could not be read, so this submission was not started. Nothing was analysed and nothing was published. Trying again in a moment is reasonable. Reports that already exist stay readable at their own addresses.`,
    contact: config.contact,
    status: 503,
  });
}

/**
 * Where the existing report for a repository lives, decorated with the newer
 * commit a fresh submission just resolved. The verdict page reads that
 * decoration to offer the explicit refresh, so a repeat submission never
 * silently re-analyses; it lands back on the report that already exists.
 */
function stalePath(latest: Report, newerSha: string): string {
  const path = verdictPath(latest);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}newer=${encodeURIComponent(newerSha)}`;
}

function reanalysisTooSoonPage(sha: string, waitMs: number, config: Config): Response {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return messagePage({
    title: "Too soon to refresh - chainoftrust.dev",
    heading: "This repository was analysed too recently to refresh",
    message: `The report at commit ${sha.slice(0, 7)} is the most recent one on file for this repository, and refreshing it again is not available for about ${minutes} more minute${minutes === 1 ? "" : "s"}. This floor exists so a busy repository cannot be used to spend fresh analyses by hammering the refresh action. The existing report is still readable at its own address.`,
    contact: config.contact,
    status: 429,
  });
}

interface BadgeMatch {
  owner: string;
  name: string;
}

/** /badge/github/:owner/:name.svg — repo-scoped, never pinned to a commit. */
function matchBadgePath(pathname: string): BadgeMatch | null {
  const parts = decodeSegments(pathname);
  if (!parts) return null;
  if (parts[0] !== "badge" || parts[1] !== "github") return null;
  const owner = parts[2];
  const file = parts[3];
  if (!owner || !file || !file.endsWith(".svg")) return null;
  const name = file.slice(0, -".svg".length);
  return name ? { owner, name } : null;
}

/**
 * One D1 read, the same lookup the repo-latest report route uses. Never
 * triggers an analysis: a repository with no report on file gets an honest
 * "not analyzed" badge linking to the intake form, not a spent slot. This is
 * what makes a bare README embed safe to let anyone's browser fetch, with no
 * rate limit and no submission counter touched.
 */
async function handleBadge(store: Store, match: BadgeMatch): Promise<Response> {
  const stored = await store.getLatestForRepo(match.owner, match.name);
  const svg = stored
    ? badgeSvg({ verdict: stored.report.verdict, href: verdictPath(stored.report) })
    : badgeSvg({ href: "/" });

  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // A found badge only changes when a new report replaces it, which the
      // refresh floor (MIN_REANALYSIS_INTERVAL_MS) already holds to an hour,
      // so an hour of caching never shows a badge staler than the data behind
      // it could be anyway. The not-analyzed case is cached for far less,
      // since the very next thing that could happen to it is someone running
      // the analysis this badge just linked them to.
      "cache-control": stored ? "public, max-age=3600" : "public, max-age=60",
    },
  });
}

interface VerdictMatch {
  owner: string;
  name: string;
  sha?: string;
}

function matchVerdictPath(pathname: string): VerdictMatch | null {
  const parts = decodeSegments(pathname);
  if (!parts) return null;
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

  const stored: StoredVerdict | null = match.sha
    ? await store.getVerdictForQuery(
        match.owner,
        match.name,
        match.sha,
        url.searchParams.get("pkg"),
      )
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
      path: url.pathname,
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

  // The "newer" decoration only ever comes from a redirect this Worker itself
  // wrote (see stalePath). It is still visitor-suppliable on a raw GET, so it
  // is shape-checked and, when it names the commit this report already is,
  // dropped: a stale banner on a report that is not stale is not honest.
  const newerParam = url.searchParams.get("newer");
  const newerCommit =
    newerParam && /^[0-9a-f]{4,64}$/i.test(newerParam) && newerParam !== stored.report.target.sha
      ? newerParam
      : null;

  return verdictPage(stored, config.contact, Boolean(match.sha), newerCommit);
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
