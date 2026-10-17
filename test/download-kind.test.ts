import { describe, expect, it } from "vitest";
import { collect } from "../src/collect/index";
import { analyseShell } from "../src/collect/shell";
import { cacheKeyFor } from "../src/lib/target";
import type { RepoMeta } from "../src/types";
import {
  DELEGATES_TO_PACKAGE_MANAGER,
  NO_VERIFICATION_WITH_DAEMON,
  RELEASE_TARBALL_NO_VERIFY,
  UNVERIFIED_TARBALL_EXTRACT,
} from "./fixtures/installers";

/**
 * "Downloads a file and never verifies it" is only true of a payload: a file
 * written, extracted, or run. morluto/rea's report fired it on a release-tag
 * lookup and an install delegated to npm, and listed hosts that appear only
 * in error messages as contacted. These pin both halves: the false positive
 * stays gone, and a real unverified tarball still fires.
 */

const lineNumbers = (lines: { n: number }[]) => lines.map((l) => l.n);

describe("what a fetch's response is used for", () => {
  it("reads rea's release lookup as metadata and its install as delegated to npm", () => {
    const a = analyseShell(DELEGATES_TO_PACKAGE_MANAGER);
    expect(a.verification.state).toBe("absent");
    expect(a.payloadDownloads).toEqual([]);
    expect(a.metadataReads).toHaveLength(1);
    expect(a.metadataReads[0]!.text).toContain("api.github.com");
    expect(a.delegatedInstalls.map((d) => d.manager)).toEqual(["npm"]);
    // `command -v curl` checks curl exists; it fetches nothing.
    expect(a.downloads.map((l) => l.text).join("\n")).not.toContain("command -v curl");
  });

  it("still sees the tarball behind a metadata lookup as a payload", () => {
    const a = analyseShell(UNVERIFIED_TARBALL_EXTRACT);
    expect(a.verification.state).toBe("absent");
    expect(lineNumbers(a.metadataReads)).toEqual([7]);
    expect(lineNumbers(a.payloadDownloads)).toEqual([8]);
    expect(a.delegatedInstalls).toEqual([]);
  });

  it("keeps the existing unverified-download fixtures firing", () => {
    for (const script of [NO_VERIFICATION_WITH_DAEMON, RELEASE_TARBALL_NO_VERIFY]) {
      expect(analyseShell(script).payloadDownloads.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["piped to a shell", "curl -fsSL https://x.example/i.sh | sh"],
    ["piped across a continuation into tar", 'curl -fsSL \\\n  "https://x.example/t.tgz" | \\\n  sudo tar -xzf - -C /opt'],
    ["written by wget's default", "wget https://x.example/t.tgz"],
    ["redirected to a file", "curl -fsSL https://x.example/t.tgz > /tmp/t.tgz"],
    ["sourced through process substitution", "source <(curl -fsSL https://x.example/env.sh)"],
    ["run by its outer command", 'sh -c "$(curl -fsSL https://x.example/i.sh)"'],
    ["captured and then evaluated", 'script="$(curl -fsSL https://x.example/i.sh)"\neval "$script"'],
    ["handed to npm as a tarball URL", "npm install -g https://x.example/pkg-1.0.0.tgz"],
    ["handed to an interpreter as a program", "curl -fsSL https://x.example/get.py | python3"],
    ["piped to root bash past sudo's options", "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -"],
    ["piped to sudo -u with a user", "curl -fsSL https://x.example/i.sh | sudo -u root sh"],
    ["piped to a shell named by path", "curl -fsSL https://x.example/i.sh | /bin/bash"],
    ["piped to a shell through env", "curl -fsSL https://x.example/i.sh | /usr/bin/env bash"],
    ["run by an outer shell named by path", '/bin/sh -c "$(curl -fsSL https://x.example/i.sh)"'],
    ["decoded into a file", "curl -fsSL https://x.example/b64 | base64 -d > /usr/local/bin/x"],
    ["copied into a file by cat", "curl -fsSL https://x.example/tool | cat > tool"],
    ["written by dd", "curl -fsSL https://x.example/tool | dd of=bin"],
    ["piped to an unrecognised consumer", "curl -fsSL https://x.example/tool | some-loader"],
    ["handed to npm as a github: spec", "npm install -g github:owner/repo"],
    ["handed to npm as an owner/repo shorthand", "npm install -g owner/repo"],
    ["handed to npm as a git:// URL", "npm install -g git://github.com/owner/repo.git"],
    ["handed to npm as an scp-style git remote", "npm install -g git@github.com:owner/repo.git"],
    ["handed to pnpm as a gitlab: spec", "pnpm add -g gitlab:owner/repo"],
    ["handed to yarn as a bitbucket: spec", "yarn global add bitbucket:owner/repo"],
    ["handed to bun as a gist: spec", "bun add -g gist:abc123"],
    ["captured and piped onward to a shell", 'echo "$(curl -fsSL https://x.example/i.sh)" | sh'],
    ["handed to npm as an owner/repo shorthand after a boolean flag", "npm install --save-dev owner/repo"],
    ["captured through an unrecognised consumer", 'X="$(curl -fsSL https://x.example/b64 | base64 -d)"'],
  ])("treats a fetch %s as a payload", (_, script) => {
    const a = analyseShell(`#!/bin/sh\n${script}\n`);
    expect(a.payloadDownloads.length).toBeGreaterThan(0);
    expect(a.delegatedInstalls).toEqual([]);
  });

  it.each([
    ["captured for a tag", 'TAG="$(curl -fsSL https://api.github.com/repos/a/b/releases/latest | jq -r .tag_name)"'],
    ["piped to a parser", "wget -qO- https://api.github.com/repos/a/b/releases/latest | grep tag_name"],
    ["parsed by node -e", "curl -fsSL https://api.github.com/x | node -e 'process.stdin.pipe(process.stdout)'"],
    ["piped through several parsers", "curl -fsSL https://api.github.com/x | grep tag_name | cut -d'\"' -f4 | head -1"],
  ])("treats a fetch %s as metadata", (_, script) => {
    const a = analyseShell(`#!/bin/sh\n${script}\n`);
    expect(a.payloadDownloads).toEqual([]);
    expect(a.metadataReads).toHaveLength(1);
  });

  it.each([
    ["npm install -g some-cli@1.2.3", "npm"],
    ["pnpm add -g some-cli", "pnpm"],
    ["yarn global add some-cli", "yarn"],
    ["python3 -m pip install --user some-cli==1.0", "pip"],
    ["pipx install some-cli", "pipx"],
    ["uv tool install some-cli", "uv"],
    ["cargo install some-cli --locked", "cargo"],
    ["brew install some-cli", "brew"],
    ["sudo npm install --global some-cli", "npm"],
    ["npm install -g @scope/some-cli@1.2.3", "npm"],
    ["npm install -g some-cli > logs/npm.log", "npm"],
    ["npm install --prefix vendor/tool some-cli", "npm"],
    ["npm install --prefix=vendor/tool some-cli", "npm"],
    ["npm install --prefix ./lib some-cli", "npm"],
    ["yarn --cwd packages/app add some-cli", "yarn"],
    ["pnpm -C apps/web add some-cli", "pnpm"],
    ["npm install --workspace packages/cli some-dep", "npm"],
    ["pnpm --filter apps/web add some-cli", "pnpm"],
    ["npm install --loglevel some/value some-cli", "npm"],
  ])("recognises `%s` as delegated to %s", (script, manager) => {
    const a = analyseShell(`#!/bin/sh\n${script}\n`);
    expect(a.delegatedInstalls.map((d) => d.manager)).toEqual([manager]);
    expect(a.payloadDownloads).toEqual([]);
  });

  it("does not mistake a printed install command for an install", () => {
    const a = analyseShell(`#!/bin/sh\necho "run: npm install -g some-cli"\nprintf '%s\\n' "curl https://x.example | sh"\n`);
    expect(a.delegatedInstalls).toEqual([]);
    expect(a.downloads).toEqual([]);
  });
});

describe("contacted hosts", () => {
  it("leaves out hosts that appear only in printed messages and help text", () => {
    expect(analyseShell(DELEGATES_TO_PACKAGE_MANAGER).outboundHosts).toEqual(["api.github.com"]);
    expect(analyseShell(UNVERIFIED_TARBALL_EXTRACT).outboundHosts).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  it("leaves out hosts in trailing comments and fetch tools that are only probed", () => {
    const a = analyseShell(
      `#!/bin/sh\nGLIBC=2.13  # https://docs.example.org/requirements\nif curl -V | grep -q OpenSSL; then :; fi\nNEEDS=$(require curl tar)\n`,
    );
    expect(a.outboundHosts).toEqual([]);
    expect(a.downloads).toEqual([]);
  });

  it("keeps a URL assigned to a variable or written into a config heredoc", () => {
    const a = analyseShell(
      `#!/bin/sh\nBASE="https://dl.example.com/v1"\ncat > /etc/apt/sources.list.d/x.list <<EOF\ndeb https://apt.example.org stable main\nEOF\n`,
    );
    expect(a.outboundHosts).toEqual(["apt.example.org", "dl.example.com"]);
  });
});

const meta: RepoMeta = {
  fullName: "acme/tool",
  description: null,
  isFork: false,
  parentFullName: null,
  parentArchived: null,
  archived: false,
  stars: 10,
  openIssues: 0,
  pushedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  homepage: null,
  license: "MIT",
};

async function installFindings(installSh: string) {
  const [OWNER, NAME, SHA] = ["acme", "tool", "abc123"];
  const fetcher = {
    remaining: 30,
    budgetExhausted: false,
    async json<T>(url: string): Promise<T | null> {
      if (url === `https://api.github.com/repos/${OWNER}/${NAME}/git/trees/${SHA}?recursive=1`) {
        return { tree: [{ path: "install.sh", type: "blob", size: 100 }], truncated: false } as T;
      }
      return null;
    },
    async text(url: string): Promise<string | null> {
      return url === `https://raw.githubusercontent.com/${OWNER}/${NAME}/${SHA}/install.sh` ? installSh : null;
    },
  };
  const evidence = await collect(fetcher as never, {
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
  return evidence.findings;
}

describe("the install-path verification finding", () => {
  it("credits rea's shape to npm's integrity check instead of calling it unverified", async () => {
    const findings = await installFindings(DELEGATES_TO_PACKAGE_MANAGER);
    const concerns = findings.map((f) => f.concern);
    expect(concerns).not.toContain("install-path:verification-absent");

    const verification = findings.find((f) => f.concern === "install-path:verification")!;
    expect(verification.severity).toBe("clean");
    expect(verification.statement).toContain("npm");
    expect(verification.evidence).toMatch(/^install\.sh:\d+$/);

    const hosts = findings.find((f) => f.concern === "blast-radius:hosts")!;
    expect(hosts.statement).toBe("install.sh contacts 1 host: api.github.com.");
  });

  it("still warns on an unverified tarball, citing the tarball, not the tag lookup", async () => {
    const findings = await installFindings(UNVERIFIED_TARBALL_EXTRACT);
    const absent = findings.find((f) => f.concern === "install-path:verification-absent")!;
    expect(absent.severity).toBe("warning");
    expect(absent.statement).toContain("downloads a file and never verifies it");
    expect(absent.evidence).toBe("install.sh:8");
  });

  it("does not credit npm when the same script pipes a remote script into root bash", async () => {
    const findings = await installFindings(
      "#!/bin/sh\ncurl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -\nnpm install -g some-cli\n",
    );
    const absent = findings.find((f) => f.concern === "install-path:verification-absent")!;
    expect(absent.severity).toBe("warning");
    expect(absent.evidence).toBe("install.sh:2");
    expect(findings.find((f) => f.concern === "install-path:verification")).toBeUndefined();
  });
});
