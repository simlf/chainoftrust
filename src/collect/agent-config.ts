import { label, labelList } from "../lib/label";
import type { Finding, TreeEntry } from "../types";

/**
 * Agent-config auto-discovery, by file presence, independent of any install
 * step.
 *
 * This is adjustment 2 from the validation report and it is the check with no
 * competitor. Merely cloning a repository caused its skills to register into
 * the auditing agent's own harness on three of eight targets, before any
 * installer ran. Three-for-three on an unplanned side channel.
 *
 * It is also this pipeline's own hazard, which is why the collector works from
 * a file listing rather than a checkout: there is no clone, so there is nothing
 * for a target to register into. See src/lib/fetcher.ts.
 */

interface Pattern {
  test: (path: string) => boolean;
  label: string;
  /** Does this fire on clone alone, or only when an installer runs? */
  trigger: "on-clone" | "on-install";
  severity: Finding["severity"];
}

const PATTERNS: Pattern[] = [
  {
    label: "Claude Code hook manifest",
    test: (p) => /(^|\/)hooks\.json$/.test(p) || /(^|\/)\.claude\/settings\.json$/.test(p),
    trigger: "on-clone",
    severity: "warning",
  },
  {
    label: "Claude Code plugin manifest",
    test: (p) => /^\.claude-plugin\//.test(p),
    trigger: "on-clone",
    severity: "warning",
  },
  {
    label: "agent skill definition",
    test: (p) => /(^|\/)SKILL\.md$/.test(p),
    trigger: "on-clone",
    severity: "warning",
  },
  {
    label: "MCP server registration",
    test: (p) => /(^|\/)\.mcp\.json$/.test(p) || /(^|\/)mcp_settings\.json$/.test(p),
    trigger: "on-clone",
    severity: "warning",
  },
  {
    label: "agent instruction file",
    test: (p) => /^(CLAUDE|AGENTS|GEMINI)\.md$/.test(p) || /(^|\/)\.cursorrules$/.test(p),
    trigger: "on-clone",
    severity: "note",
  },
  {
    label: "harness extension",
    test: (p) => /^\.pi\/extensions\//.test(p) || /^\.opencode\/plugins\//.test(p),
    trigger: "on-clone",
    severity: "warning",
  },
  {
    label: "agent command or subagent definition",
    test: (p) => /^\.claude\/(commands|agents|helpers)\//.test(p),
    trigger: "on-clone",
    severity: "note",
  },
  {
    label: "per-harness plugin manifest",
    test: (p) => /^\.(codex|cursor|kimi)-plugin\//.test(p),
    trigger: "on-clone",
    severity: "note",
  },
];

/** Hook events that fire without the user invoking anything by name. */
const UNCONDITIONAL_HOOKS =
  /"(SessionStart|PreToolUse|PostToolUse|Stop|PreCompact|SubagentStop|Notification|UserPromptSubmit)"/g;

export interface AgentConfigScan {
  findings: Finding[];
  /** Hook manifests worth fetching and parsing, capped by the caller. */
  hookManifests: string[];
  skillCount: number;
}

export function scanAgentConfig(entries: TreeEntry[]): AgentConfigScan {
  const findings: Finding[] = [];
  const hookManifests: string[] = [];
  const matched = new Map<string, string[]>();

  for (const entry of entries) {
    for (const pattern of PATTERNS) {
      if (!pattern.test(entry.path)) continue;
      const list = matched.get(pattern.label) ?? [];
      list.push(entry.path);
      matched.set(pattern.label, list);
    }
    if (/(^|\/)hooks\.json$/.test(entry.path) || /(^|\/)\.claude\/settings\.json$/.test(entry.path)) {
      hookManifests.push(entry.path);
    }
  }

  for (const pattern of PATTERNS) {
    const paths = matched.get(pattern.label);
    if (!paths || paths.length === 0) continue;
    // labelList states its own remainder, so the citation must not add a second.
    const shown = labelList(paths, 3);
    findings.push({
      check: "agent-config",
      severity: pattern.severity,
      concern: `agent-config:${pattern.label}`,
      statement:
        pattern.trigger === "on-clone"
          ? `The repository ships ${paths.length} ${pattern.label}${paths.length === 1 ? "" : "s"}. A harness that indexes a cloned working tree can pick these up without any install step being run.`
          : `The repository ships ${paths.length} ${pattern.label}${paths.length === 1 ? "" : "s"}.`,
      evidence: shown,
      method: "tree",
    });
  }

  if (findings.length === 0) {
    findings.push({
      check: "agent-config",
      severity: "clean",
      concern: "agent-config:auto-discovery",
      statement:
        "No agent configuration files are present: no hook manifest, no skill definition, no MCP registration, no plugin manifest.",
      evidence: `file listing at the analysed commit, ${entries.length} files`,
      method: "tree",
    });
  }

  return {
    findings,
    hookManifests: hookManifests.slice(0, 3),
    skillCount: (matched.get("agent skill definition") ?? []).length,
  };
}

/**
 * Read a hook manifest and report which lifecycle events it registers.
 *
 * The line the design needs and did not have: a plain SKILL.md enters context
 * only when the model chooses to invoke it, whereas a hook wired into
 * hooks.json injects on every session start regardless of intent. Superpowers
 * ships both, and the difference is the whole risk delta.
 */
export function analyseHookManifest(path: string, source: string): Finding[] {
  const events = new Set<string>();
  for (const m of source.matchAll(UNCONDITIONAL_HOOKS)) events.add(m[1]!);

  if (events.size === 0) return [];

  const commands = [...source.matchAll(/"command"\s*:\s*"([^"]{0,160})"/g)].map((m) => m[1]!);

  const findings: Finding[] = [
    {
      check: "agent-config",
      severity: "warning",
      concern: "agent-config:hooks",
      statement: `The hook manifest registers ${events.size} lifecycle hook${events.size === 1 ? "" : "s"}: ${labelList([...events].sort())}. Hooks run when their event fires, without the user invoking anything by name.`,
      evidence: label(path),
      method: "file",
    },
  ];

  if (commands.length > 0) {
    findings.push({
      check: "agent-config",
      severity: "note",
      concern: "agent-config:hook-commands",
      statement: `The hook manifest runs ${commands.length} command${commands.length === 1 ? "" : "s"}. The first is quoted verbatim.`,
      evidence: label(path),
      method: "file",
      quote: commands[0]!,
    });
  }

  // A maintainer flagging their own hook file is a fact worth carrying: the
  // claude-flow manifest self-labels "_legacy_unaudited_shim": true.
  const selfFlag = /"_?[a-z_]*unaudited[a-z_]*"\s*:\s*true/i.exec(source);
  if (selfFlag) {
    findings.push({
      check: "agent-config",
      severity: "warning",
      concern: "agent-config:self-flagged",
      statement: "The hook manifest marks itself unaudited. The field it does that with is quoted verbatim.",
      evidence: label(path),
      method: "file",
      quote: selfFlag[0],
    });
  }

  return findings;
}
