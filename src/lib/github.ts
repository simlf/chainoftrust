import type { Fetcher } from "./fetcher";
import { isRepoIdentifier, isSafeRef } from "./target";
import type { ReleaseInfo, RepoMeta, TreeEntry } from "../types";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

interface RepoResponse {
  full_name: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  stargazers_count: number;
  open_issues_count: number;
  pushed_at: string;
  created_at: string;
  homepage: string | null;
  license: { spdx_id: string | null } | null;
  parent?: { full_name: string; archived: boolean };
}

export async function fetchRepo(
  f: Fetcher,
  owner: string,
  name: string,
): Promise<{ meta: RepoMeta; defaultBranch: string } | null> {
  const r = await f.json<RepoResponse>(`${API}/repos/${owner}/${name}`);
  if (!r) return null;
  return {
    defaultBranch: r.default_branch,
    meta: {
      fullName: r.full_name,
      description: r.description,
      isFork: r.fork,
      // The validation report's Target 4 turned on exactly this: a secondary
      // source described the archived *parent* as if it were the fork. Ground
      // truth is the repo's own fork/parent/pushed_at fields, never a summary.
      parentFullName: r.parent?.full_name ?? null,
      parentArchived: r.parent ? r.parent.archived : null,
      archived: r.archived,
      stars: r.stargazers_count,
      openIssues: r.open_issues_count,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      homepage: r.homepage,
      license: r.license?.spdx_id ?? null,
    },
  };
}

/**
 * Resolve a branch, tag or short sha to the full commit sha we pin to.
 *
 * The ref is encoded segment by segment. A slash inside a branch name is part
 * of the path GitHub expects, and percent-encoding it makes the commits
 * endpoint reject the request, so `release/1.x` would never resolve.
 */
export async function resolveSha(
  f: Fetcher,
  owner: string,
  name: string,
  ref: string,
): Promise<string | null> {
  if (!isRepoIdentifier(owner, name) || !isSafeRef(ref) || ref === "") return null;
  const r = await f.json<{ sha: string }>(
    `${API}/repos/${owner}/${name}/commits/${encodeRef(ref)}`,
  );
  return r?.sha ?? null;
}

export function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * The whole file listing with sizes, in one call and with nothing downloaded.
 * This is what powers the agent-config auto-discovery check and the
 * unauditable-surface census.
 */
export async function fetchTree(
  f: Fetcher,
  owner: string,
  name: string,
  sha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
  const r = await f.json<{
    tree: { path: string; type: string; size?: number }[];
    truncated: boolean;
  }>(`${API}/repos/${owner}/${name}/git/trees/${sha}?recursive=1`);
  if (!r?.tree) return null;
  return {
    truncated: Boolean(r.truncated),
    entries: r.tree
      .filter((e) => e.type === "blob")
      .map((e) => ({ path: e.path, size: e.size ?? 0 })),
  };
}

export async function fetchLatestRelease(
  f: Fetcher,
  owner: string,
  name: string,
): Promise<ReleaseInfo | null> {
  const r = await f.json<{
    tag_name: string;
    assets: { name: string; size: number }[];
  }>(`${API}/repos/${owner}/${name}/releases/latest`);
  if (!r) return null;
  return {
    tag: r.tag_name,
    assets: (r.assets ?? []).map((a) => ({ name: a.name, size: a.size })),
  };
}

export interface ContributorStats {
  total: number;
  topLogin: string | null;
  topShare: number;
}

/**
 * First page only, ordered by contribution count. Enough to answer "is this one
 * person" without paginating a 400-contributor project. The count is reported
 * as a floor, never as a total, so the verdict cannot overstate it.
 */
export async function fetchContributors(
  f: Fetcher,
  owner: string,
  name: string,
): Promise<ContributorStats | null> {
  const r = await f.json<{ login: string; contributions: number }[]>(
    `${API}/repos/${owner}/${name}/contributors?per_page=100`,
  );
  if (!r || !Array.isArray(r) || r.length === 0) return null;
  const total = r.reduce((sum, c) => sum + c.contributions, 0);
  const top = r[0]!;
  return {
    total: r.length,
    topLogin: top.login,
    topShare: total > 0 ? top.contributions / total : 0,
  };
}

export function rawUrl(owner: string, name: string, sha: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${RAW}/${owner}/${name}/${sha}/${encoded}`;
}
