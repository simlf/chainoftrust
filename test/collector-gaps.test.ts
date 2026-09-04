import { describe, expect, it } from "vitest";
import { collect } from "../src/collect/index";
import { cacheKeyFor } from "../src/lib/target";
import type { RepoMeta } from "../src/types";

/**
 * Regression fixture for the two blind spots the strudel-claude dogfood run
 * exposed (docs/seed-dataset.md context: data/cot-strudel-claude-report):
 *
 *   1. A committed .claude/settings.local.json, pre-authorizing wildcard Bash
 *      grants, was never fetched — agent-config.ts only matched
 *      settings.json.
 *   2. .claude/CLAUDE.md was invisible to both prose-facing collectors, which
 *      assumed CLAUDE.md sits at the repository root.
 *
 * This mirrors the real repository's shape closely enough to exercise both
 * fixes together, without pulling in its full 37-file tree.
 */

const meta: RepoMeta = {
  fullName: "renatoworks/strudel-claude",
  description: "An experiment to play and learn Strudel with Claude Code",
  isFork: false,
  parentFullName: null,
  parentArchived: null,
  archived: false,
  stars: 1,
  openIssues: 0,
  pushedAt: "2026-02-03T19:30:00Z",
  createdAt: "2026-02-03T14:21:54Z",
  homepage: null,
  license: "MIT",
};

const OWNER = "renatoworks";
const NAME = "strudel-claude";
const SHA = "a62f4f0";

const TREE_ENTRIES = [
  "package.json",
  "README.md",
  ".claude/settings.local.json",
  ".claude/CLAUDE.md",
  ".claude/skills/api/SKILL.md",
  ".claude/skills/dj-set/SKILL.md",
  "src/app/api/route.ts",
];

const FILE_TEXT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "strudel-claude", private: true }),
  "README.md": "An experiment to play and learn Strudel with Claude Code.",
  ".claude/settings.local.json": JSON.stringify({
    permissions: {
      allow: ["Skill(api)", "Skill(dj-set)", "Bash(sleep *)", "Bash(say *)", "Bash(curl *)"],
    },
  }),
  ".claude/CLAUDE.md":
    "You are the Strudel DJ persona. Greet the user and pick a session mode before doing anything else.",
};

function fakeFetcher() {
  const seen: string[] = [];
  const f = {
    seen,
    remaining: 30,
    budgetExhausted: false,
    async json<T>(url: string): Promise<T | null> {
      seen.push(url);
      if (url === `https://api.github.com/repos/${OWNER}/${NAME}/git/trees/${SHA}?recursive=1`) {
        return {
          tree: TREE_ENTRIES.map((path) => ({ path, type: "blob", size: 100 })),
          truncated: false,
        } as T;
      }
      return null;
    },
    async text(url: string): Promise<string | null> {
      seen.push(url);
      for (const [path, text] of Object.entries(FILE_TEXT)) {
        if (url === `https://raw.githubusercontent.com/${OWNER}/${NAME}/${SHA}/${path}`) return text;
      }
      return null;
    },
  };
  return f;
}

describe("collector coverage against strudel-claude's real layout", () => {
  it("fetches the committed settings.local.json and the nested CLAUDE.md, and finds both", async () => {
    const f = fakeFetcher();
    const evidence = await collect(f as never, {
      target: {
        cacheKey: cacheKeyFor(OWNER, NAME, SHA),
        host: "github",
        owner: OWNER,
        name: NAME,
        requestedRef: "",
        sha: SHA,
        defaultBranch: "main",
      },
      meta,
    });

    expect(f.seen).toContain(
      `https://raw.githubusercontent.com/${OWNER}/${NAME}/${SHA}/.claude/settings.local.json`,
    );
    expect(f.seen).toContain(
      `https://raw.githubusercontent.com/${OWNER}/${NAME}/${SHA}/.claude/CLAUDE.md`,
    );

    const concerns = evidence.findings.map((x) => x.concern);
    expect(concerns).toContain("agent-config:local-settings-committed");
    expect(concerns).toContain("agent-config:permission-grant");
    expect(concerns).toContain("agent-config:agent instruction file");

    const grantFinding = evidence.findings.find(
      (x) => x.concern === "agent-config:permission-grant",
    )!;
    expect(grantFinding.quote).toMatch(/^Bash\(/);

    const localSettingsFinding = evidence.findings.find(
      (x) => x.concern === "agent-config:local-settings-committed",
    )!;
    expect(localSettingsFinding.evidence).toContain("settings.local.json");
  });

  it("stays inside the file-fetch budget on this shape", async () => {
    const f = fakeFetcher();
    const evidence = await collect(f as never, {
      target: {
        cacheKey: cacheKeyFor(OWNER, NAME, SHA),
        host: "github",
        owner: OWNER,
        name: NAME,
        requestedRef: "",
        sha: SHA,
        defaultBranch: "main",
      },
      meta,
    });

    // package.json, README.md, .claude/settings.local.json, .claude/CLAUDE.md:
    // the widened patterns cost exactly the two new files that actually exist,
    // not a blanket increase in the fetch budget.
    expect(evidence.stats.filesFetched).toBe(4);
  });
});
