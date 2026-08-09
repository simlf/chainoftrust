/**
 * Static reading of a POSIX install script.
 *
 * The validation report's sharpest result was that keyword presence is a weak
 * signal and reachability is a strong one. Four targets, four different
 * flavours of "the mechanism exists but does not run":
 *
 *   uv       verification present, silently no-ops when sha256sum is absent
 *   aider    checksum variables declared but never assigned, branch is dead
 *   Ollama   release publishes sha256sum.txt, installer never names it
 *   puppeteer a dependency exposes a hash check the call site never passes
 *
 * So this module answers three separate questions, and the caller is expected
 * to keep them separate in the verdict:
 *
 *   Is there verification code at all?
 *   Are the values it compares ever actually produced?
 *   Can it fall through without failing?
 *
 * It reads text. It never runs anything.
 */

export interface Line {
  n: number;
  text: string;
}

export type VerificationState =
  | "absent"
  | "unreachable"
  | "can-skip-silently"
  | "enforced";

export interface ShellAnalysis {
  lineCount: number;
  sudo: Line[];
  pipeToShell: Line[];
  downloads: Line[];
  verification: {
    state: VerificationState;
    /** Lines that invoke a hashing or signature tool. */
    tooling: Line[];
    /** Variables a verification site reads but nothing ever assigns. */
    unassignedVars: string[];
    /** Lines that let the script continue without verifying. */
    skipPaths: Line[];
    /** Lines where a mismatch stops the script. */
    abortSites: Line[];
  };
  executesDownload: Line[];
  residency: Line[];
  agentConfigWrites: Line[];
  envVars: string[];
  outboundHosts: string[];
}

const HASH_TOOLS =
  /\b(sha256sum|sha512sum|shasum|md5sum|openssl\s+dgst|certutil\s+-hashfile|Get-FileHash|gpg\s+--verify|minisign|cosign\s+verify|b3sum)\b/;

const CHECKSUM_WORD = /(checksum|sha256|sha512|sha-256|digest|signature|sigstore|attestation)/i;

const SKIP_PHRASE =
  /(no\s+checksums?\s+to\s+verify|skipping\s+(the\s+)?(checksum|verification|signature)|unable\s+to\s+verify|cannot\s+verify|verification\s+skipped|without\s+verif)/i;

// Any invocation of a fetch tool counts. Requiring an output flag missed the
// two commonest real shapes: `curl ... | tar -x` writes nothing to a named
// file, and a `-o` flag has no word boundary before the dash.
const DOWNLOAD = /\b(curl|wget|Invoke-WebRequest|iwr|irm|aria2c)\b/;

const PIPE_TO_SHELL = /\b(curl|wget|iwr|irm)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|d)?sh\b|\|\s*iex\b/;

const RESIDENCY =
  /\b(systemctl\s+(enable|start|restart)|launchctl\s+(load|bootstrap)|LaunchAgents|LaunchDaemons|SMAppService|nohup|brew\s+services\s+start|sc\.exe\s+create|New-Service|crontab\s+-|@reboot)\b/;

const AGENT_CONFIG =
  /(\.claude(\/|\b)|\.codex(\/|\b)|\.cursor(\/|\b)|\.mcp\.json|mcp_settings\.json|claude_desktop_config\.json|CLAUDE\.md|AGENTS\.md|\/hooks\/|hooks\.json|\/skills\/|SKILL\.md|\.claude-plugin)/;

const ENV_READ = /\$\{?([A-Z][A-Z0-9_]{2,})\}?|\benv:([A-Z][A-Z0-9_]{2,})/g;
const URL_HOST = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// Shell builtins and loop variables that are not "the installer reads your
// environment" in any interesting sense.
const BORING_ENV = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP",
  "LANG", "LC_ALL", "TERM", "IFS", "PS1", "PS2", "UID", "EUID", "OSTYPE",
  "HOSTTYPE", "MACHTYPE", "BASH_SOURCE", "FUNCNAME", "LINENO", "RANDOM",
  "SECONDS", "PPID", "SHLVL", "COLUMNS", "LINES", "PATHEXT",
]);

export function analyseShell(source: string): ShellAnalysis {
  const lines: Line[] = source
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }));

  const code = lines.filter((l) => !/^\s*#/.test(l.text));
  const assigned = collectAssignments(code);

  const tooling = code.filter((l) => HASH_TOOLS.test(l.text));
  const skipPaths = code.filter((l) => SKIP_PHRASE.test(l.text));

  // Variables the verification code reads, restricted to names that look like
  // they carry a checksum. A name never assigned anywhere means the comparison
  // can only ever take the else branch - aider's exact defect.
  const unassignedVars = new Set<string>();
  for (const line of code) {
    if (!CHECKSUM_WORD.test(line.text)) continue;
    for (const name of referencedVars(line.text)) {
      if (!CHECKSUM_WORD.test(name)) continue;
      if (!assigned.has(name)) unassignedVars.add(name);
    }
  }

  const abortSites = findAbortSites(code);
  const mentionsChecksum = code.some((l) => CHECKSUM_WORD.test(l.text));

  let state: VerificationState;
  if (!mentionsChecksum && tooling.length === 0) {
    state = "absent";
  } else if (unassignedVars.size > 0) {
    state = "unreachable";
  } else if (skipPaths.length > 0 || (tooling.length > 0 && abortSites.length === 0)) {
    state = "can-skip-silently";
  } else if (tooling.length > 0) {
    state = "enforced";
  } else {
    // The word appears but no hashing tool is ever invoked: a comment, a
    // variable name, or a message. Not verification.
    state = "absent";
  }

  return {
    lineCount: lines.length,
    sudo: code.filter((l) => /\bsudo\b|\$SUDO\b|\bdoas\b|\bRunAs\b/.test(l.text)),
    pipeToShell: code.filter((l) => PIPE_TO_SHELL.test(l.text)),
    downloads: code.filter((l) => DOWNLOAD.test(l.text)),
    verification: {
      state,
      tooling,
      unassignedVars: [...unassignedVars].sort(),
      skipPaths,
      abortSites,
    },
    executesDownload: findExecutionOfDownload(code),
    residency: code.filter((l) => RESIDENCY.test(l.text)),
    agentConfigWrites: code.filter((l) => AGENT_CONFIG.test(l.text)),
    envVars: collectEnvVars(code),
    outboundHosts: collectHosts(code),
  };
}

function collectAssignments(code: Line[]): Set<string> {
  const names = new Set<string>();
  for (const { text } of code) {
    // VAR=..., local VAR=..., export VAR=..., readonly VAR=...
    for (const m of text.matchAll(
      /(?:^|;|\s|\bthen\b|\bdo\b)\s*(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=/g,
    )) {
      names.add(m[1]!);
    }
    // read -r VAR, for VAR in ...
    for (const m of text.matchAll(/\b(?:read(?:\s+-\w+)*|for)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      names.add(m[1]!);
    }
    // PowerShell: $var = ...
    for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

function referencedVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) out.push(m[1]!);
  return out;
}

/** A comparison that leads to exit / return 1 / err / die within a few lines. */
function findAbortSites(code: Line[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < code.length; i++) {
    const line = code[i]!;
    const comparesHash =
      CHECKSUM_WORD.test(line.text) && /!=|-ne\b|-not\b|\bne\b/.test(line.text);
    if (!comparesHash) continue;
    for (let j = i; j < Math.min(i + 6, code.length); j++) {
      if (/\b(exit\s+[1-9]|return\s+[1-9]|err\b|die\b|throw\b|Write-Error|abort\b)/.test(code[j]!.text)) {
        out.push(line);
        break;
      }
    }
  }
  return out;
}

/**
 * Does the script run what it just downloaded? Distinguished from merely
 * placing it on PATH, which is what a clean installer does.
 */
function findExecutionOfDownload(code: Line[]): Line[] {
  return code.filter((l) => {
    const t = l.text;
    if (/\bchmod\s+\+x\b/.test(t)) return false;
    if (/ExecStart=/.test(t)) return true;
    if (/\b(bash|sh|zsh)\s+["']?\$\{?(TMP|TEMP|_?file|_?archive|_?dl|download)/i.test(t)) return true;
    // A freshly installed binary invoked by path, e.g. "$INSTALL_DIR/tool"
    // daemon restart. The closing quote sits between the path and the verb.
    if (
      /\$\{?(_?install_?dir|bindir|prefix|target_?dir)\}?[^\s"']*\/[A-Za-z0-9_.-]+["']?\s+(serve|start|restart|daemon|init|install|update|--version)\b/i.test(
        t,
      )
    ) {
      return true;
    }
    if (/\bopen\s+-a\b/.test(t)) return true;
    return false;
  });
}

function collectEnvVars(code: Line[]): string[] {
  const seen = new Set<string>();
  for (const { text } of code) {
    for (const m of text.matchAll(ENV_READ)) {
      const name = m[1] ?? m[2];
      if (name && !BORING_ENV.has(name)) seen.add(name);
    }
  }
  return [...seen].sort();
}

function collectHosts(code: Line[]): string[] {
  const seen = new Set<string>();
  for (const { text } of code) {
    for (const m of text.matchAll(URL_HOST)) seen.add(m[1]!.toLowerCase());
  }
  return [...seen].sort();
}

/** Env var names that look like they carry a credential. */
export function credentialShaped(names: string[]): string[] {
  return names.filter((n) =>
    /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SESSION)/.test(n),
  );
}
