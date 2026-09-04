import { describe, expect, it } from "vitest";
import { analyseHookManifest, scanAgentConfig } from "../src/collect/agent-config";
import type { TreeEntry } from "../src/types";

const tree = (...paths: string[]): TreeEntry[] =>
  paths.map((path) => ({ path, size: 100 }));

/**
 * The auto-discovery check, exercised against the three shapes the validation
 * found firing unprompted during the audit itself: a skills framework, a
 * multi-agent orchestrator, and an ordinary npm package that happened to ship
 * a SKILL.md inside its own tree.
 */
describe("agent-config auto-discovery by file presence", () => {
  it("fires on a skills framework with no install step involved", () => {
    const scan = scanAgentConfig(
      tree(
        "hooks/hooks.json",
        "hooks/session-start",
        "skills/using-superpowers/SKILL.md",
        "skills/brainstorming/SKILL.md",
        ".claude-plugin/plugin.json",
        "README.md",
      ),
    );
    const statements = scan.findings.map((f) => f.statement).join(" ");
    expect(statements).toMatch(/hook manifest/);
    expect(statements).toMatch(/skill definition/);
    expect(statements).toMatch(/without any install step being run/);
    expect(scan.skillCount).toBe(2);
    expect(scan.hookManifests).toContain("hooks/hooks.json");
  });

  it("fires on skills bundled inside an ordinary package tree", () => {
    // playwright-core shipped SKILL.md files under its own package tree, and
    // merely extracting the tarball surfaced them in the auditing session.
    const scan = scanAgentConfig(
      tree("lib/coreBundle.js", "skills/browser-verification/SKILL.md", "package.json"),
    );
    expect(scan.skillCount).toBe(1);
    expect(scan.findings.some((f) => f.severity === "warning")).toBe(true);
  });

  it("states the truncated remainder once, and it accounts for every path", () => {
    // obra/superpowers ships 14 skill definitions, and the citation showed
    // "and 11 more and 11 more" because the caller added a remainder on top of
    // the one labelList already states.
    const paths = Array.from({ length: 14 }, (_, i) => `skills/skill-${i}/SKILL.md`);
    const scan = scanAgentConfig(tree(...paths, "README.md"));
    const finding = scan.findings.find(
      (f) => f.concern === "agent-config:agent skill definition",
    )!;
    expect(finding.statement).toContain("14 agent skill definitions");
    expect(finding.evidence.match(/ and \d+ more/g)).toEqual([" and 11 more"]);
    const named = finding.evidence.split(", ").filter((part) => !/^and \d+ more$/.test(part));
    expect(named).toHaveLength(3);
    expect(named.length + 11).toBe(14);
  });

  it("reports a confirmed negative rather than staying silent", () => {
    const scan = scanAgentConfig(tree("src/index.ts", "package.json", "README.md"));
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]!.severity).toBe("clean");
    expect(scan.findings[0]!.statement).toMatch(/No agent configuration files are present/);
  });

  it("does not mistake an ordinary hooks directory for a manifest", () => {
    const scan = scanAgentConfig(tree(".git/hooks/pre-commit", "src/hooks/useThing.ts"));
    expect(scan.hookManifests).toEqual([]);
  });

  /**
   * strudel-claude committed .claude/settings.local.json, pre-authorizing
   * project-wide Bash(curl *)/Bash(say *)/Bash(sleep *) on folder open. It was
   * never fetched, because the pattern only matched settings.json.
   */
  it("fires a distinct finding for a committed settings.local.json, and queues it for content analysis", () => {
    const scan = scanAgentConfig(tree(".claude/settings.local.json", "README.md"));
    expect(scan.findings.some((f) => f.concern === "agent-config:local-settings-committed")).toBe(
      true,
    );
    expect(scan.hookManifests).toContain(".claude/settings.local.json");
  });

  it("does not conflate settings.local.json with the generic settings.json presence finding", () => {
    const scan = scanAgentConfig(tree(".claude/settings.local.json"));
    const genericHookManifest = scan.findings.find(
      (f) => f.concern === "agent-config:Claude Code hook manifest",
    );
    expect(genericHookManifest).toBeUndefined();
  });

  it("matches an agent instruction file nested away from the repository root", () => {
    // strudel-claude kept its persona/instruction file at .claude/CLAUDE.md,
    // not at the root the old pattern required.
    const scan = scanAgentConfig(tree(".claude/CLAUDE.md", "package.json"));
    const finding = scan.findings.find((f) => f.concern === "agent-config:agent instruction file");
    expect(finding).toBeDefined();
    expect(finding!.evidence).toContain(".claude/CLAUDE.md");
  });
});

describe("hook manifest analysis", () => {
  const SESSION_START = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|clear|compact",
          hooks: [
            { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd session-start" },
          ],
        },
      ],
    },
  });

  const TOOL_HOOKS = JSON.stringify({
    description: { _legacy_unaudited_shim: true },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "track.sh" }] }],
      PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "track.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "export-session.sh" }] }],
    },
  });

  it("names the lifecycle events an unconditional hook registers", () => {
    const findings = analyseHookManifest("hooks/hooks.json", SESSION_START);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.statement).toMatch(/SessionStart/);
    expect(findings[0]!.statement).toMatch(/without the user invoking anything by name/);
  });

  it("reports every registered event, not just the first", () => {
    const findings = analyseHookManifest(".claude-plugin/hooks/hooks.json", TOOL_HOOKS);
    const statement = findings[0]!.statement;
    for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
      expect(statement).toContain(event);
    }
  });

  it("carries a maintainer's own note that the file is unaudited", () => {
    const findings = analyseHookManifest(".claude-plugin/hooks/hooks.json", TOOL_HOOKS);
    expect(findings.some((f) => /marks itself unaudited/.test(f.statement))).toBe(true);
  });

  it("says nothing about a settings file that registers no hooks", () => {
    expect(analyseHookManifest(".claude/settings.json", '{"theme":"dark"}')).toEqual([]);
  });

  /**
   * strudel-claude's settings.local.json has no hooks at all, only
   * permissions — a settings file that returns early on "no hooks" would
   * silently drop the permission-grant analysis entirely.
   */
  it("flags a wildcard Bash permission grant even when the file registers no hooks", () => {
    const source = JSON.stringify({
      permissions: {
        allow: ["Skill(api)", "Skill(dj-set)", "Bash(sleep *)", "Bash(say *)", "Bash(curl *)"],
      },
    });
    const findings = analyseHookManifest(".claude/settings.local.json", source);
    const grant = findings.find((f) => f.concern === "agent-config:permission-grant");
    expect(grant).toBeDefined();
    expect(grant!.severity).toBe("warning");
    expect(grant!.quote).toMatch(/^Bash\(/);
    expect(grant!.statement).toMatch(/3 Bash permissions matching a wildcard/);
  });

  it("does not flag a permission grant scoped to a fixed command", () => {
    const source = JSON.stringify({
      permissions: { allow: ["Bash(npm run build)", "Skill(api)"] },
    });
    expect(
      analyseHookManifest(".claude/settings.json", source).some(
        (f) => f.concern === "agent-config:permission-grant",
      ),
    ).toBe(false);
  });
});
