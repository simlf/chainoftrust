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
  /** Every line that invokes a fetch tool, wherever its response goes. */
  downloads: Line[];
  /**
   * Fetches whose response becomes a file, an archive being extracted, or
   * input to a shell: the artefact a checksum would have to cover.
   */
  payloadDownloads: Line[];
  /** Fetches whose response is only captured or parsed, e.g. a release tag lookup. */
  metadataReads: Line[];
  /** Installs handed to a package manager that checks registry integrity itself. */
  delegatedInstalls: { line: Line; manager: string }[];
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
  const commands = logicalCommands(dropPrintedHeredocs(code));
  const fetches = classifyFetches(commands, code);
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
    downloads: fetches.downloads,
    payloadDownloads: fetches.payload,
    metadataReads: fetches.metadata,
    delegatedInstalls: fetches.delegated,
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
    outboundHosts: collectHosts(commands),
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

/**
 * A URL a script only prints (a help line, an error message's "install it from
 * https://...") is not a host the script contacts. Only URLs outside message
 * commands count.
 */
function collectHosts(commands: Command[]): string[] {
  const seen = new Set<string>();
  for (const cmd of commands) {
    const sc = scanCommand(cmd.text);
    for (const m of cmd.text.matchAll(URL_HOST)) {
      if (sc.comment[m.index!] || isMessage(cmd.text, sc.seg[m.index!]!)) continue;
      seen.add(m[1]!.toLowerCase());
    }
  }
  return [...seen].sort();
}

// The second calibration question after "is there a fetch": what happens to
// what it fetched. A release-tag lookup whose JSON is parsed for one field
// is not an artefact anyone could checksum; a tarball written to disk, piped
// into tar, or fed to a shell is. And an install handed to a package manager
// is verified by that manager against the registry's integrity hash, so the
// script itself invoking no hashing tool is not a gap.

/** Commands whose arguments are text shown to a person, not something run. */
const MESSAGE_COMMAND =
  /^(echo|printf|print|say|status|fail|die|err|error|warn|warning|info|log|abort|fatal|msg|note|usage|Write-Host|Write-Output|Write-Error|Write-Warning|(log|print|msg|warn|err|info|say)_[A-Za-z0-9_]+)$/;

/** What a fetched payload is handed to when it is run, extracted, or written. */
const CONSUMES_PAYLOAD =
  /^(sh|bash|zsh|dash|ksh|fish|eval|source|\.|iex|Invoke-Expression|python3?|node|perl|ruby|tar|bsdtar|unzip|gunzip|gzip|bunzip2|xz|unxz|zstd|7z|install|dpkg|rpm|tee)$/;

/** Commands that only read what is piped to them, as text to search or reshape. */
const PARSES_TEXT =
  /^(jq|yq|grep|egrep|fgrep|rg|sed|awk|gawk|mawk|cut|head|tail|tr|sort|uniq|wc|read|ConvertFrom-Json|Select-String|Select-Object|findstr)$/;

/** Interpreter flags that make the interpreter parse its stdin, not run it. */
const PARSES_STDIN = /^\s+(-c|-e|-p|--eval|--print)\b/;

/** Words that check a tool exists rather than run it: `command -v curl`. */
const PROBES_TOOL = /\b(command\s+-v|which|type|hash|require|find_tool|need_cmd|check_cmd|has_cmd|require_cmd|require_command|has_command)\s+["']?$/;

/**
 * Package managers that check every package they fetch against integrity data
 * published by the registry (npm/yarn/pnpm/bun's sha512 `integrity`, pip and
 * uv's index hashes, cargo's index checksum, go's sumdb, brew's bottle sha256).
 * Each pattern matches the arguments from the first non-flag one.
 */
const PACKAGE_MANAGERS: Record<string, RegExp> = {
  npm: /^(install|i|add|ci|update)\b/,
  pnpm: /^(install|i|add|update)\b/,
  yarn: /^(install|add|global\s+add)\b/,
  bun: /^(install|i|add)\b/,
  pip: /^install\b/,
  pip3: /^install\b/,
  pipx: /^install\b/,
  uv: /^(tool\s+install|pip\s+install|add)\b/,
  cargo: /^install\b/,
  brew: /^(install|reinstall|upgrade)\b/,
  go: /^install\b/,
};

/** An argument that names an artefact directly, bypassing the registry's hash. */
const UNREGISTERED_ARTEFACT =
  /https?:\/\/|\bgit\+|\bgit(@|:\/\/)|\bssh:\/\/|\b(github|gitlab|bitbucket|gist|file):|\.(tgz|tar\.gz|whl|zip)\b/;

/** npm-family managers read a bare `owner/repo` argument as a GitHub repository. */
const HOSTED_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#\S*)?$/;
const NPM_FAMILY = /^(npm|pnpm|yarn|bun)$/;

/** Package-manager flags whose next word is a value (a directory, a URL), not a package. */
const TAKES_VALUE =
  /^(--prefix|--cwd|-C|--dir|--registry|--cache|--userconfig|--globalconfig|--global-folder|--target|-t|-w|--workspace|--filter|-F)$/;

/** Install flags known to take no value, so the word after one can be a package. */
const BOOLEAN_FLAG =
  /^(-g|--global|-D|--save-dev|-E|--save-exact|-S|--save|-O|--save-optional|--no-save|-f|--force|--legacy-peer-deps|--ignore-scripts|--locked|--user)$/;

/** The words of a command line, with redirections and their targets dropped. */
function argWords(args: string): string[] {
  return args
    .replace(/\d*>{1,2}&?\s*\S+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** The words of a package-manager command line that can name a package. */
function positionalArgs(args: string): string[] {
  const words = argWords(args);
  const out: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (TAKES_VALUE.test(w)) k++;
    else if (!w.startsWith("-")) out.push(w);
  }
  return out;
}

/**
 * Whether an npm-family install names a bare `owner/repo`. A word right after
 * a flag not known to be boolean is taken as that flag's value, not a package.
 */
function namesHostedShorthand(args: string): boolean {
  const words = argWords(args);
  return words.some((w, k) => {
    const prev = words[k - 1] ?? "";
    const afterValueFlag = prev.startsWith("-") && !prev.includes("=") && !BOOLEAN_FLAG.test(prev);
    return !afterValueFlag && !w.startsWith("-") && !/^(\.{1,2}\/|\/|~)/.test(w) && HOSTED_SHORTHAND.test(w);
  });
}

interface Command {
  text: string;
  lines: Line[];
}

interface Scan {
  /** Start index of the simple command each character belongs to. */
  seg: number[];
  /** Nesting depth of command substitutions and subshells at each character. */
  depth: number[];
  /** Whether each character sits inside a process substitution, `<(...)`. */
  proc: boolean[];
  /** Whether each character is part of a trailing `# comment`. */
  comment: boolean[];
}

/** Join backslash- and pipe-continued lines into the command they form. */
function logicalCommands(code: Line[]): Command[] {
  const out: Command[] = [];
  let cur: Command | null = null;
  for (const line of code) {
    if (cur) {
      cur.text += "\n" + line.text;
      cur.lines.push(line);
    } else {
      cur = { text: line.text, lines: [line] };
    }
    if (!/(\\|\||&&)\s*$/.test(line.text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Remove the bodies of heredocs that only print text (`cat <<EOF` to the
 * terminal, a usage block). A heredoc piped or redirected somewhere is
 * content the script writes or runs, and stays.
 */
function dropPrintedHeredocs(code: Line[]): Line[] {
  const out: Line[] = [];
  let terminator: string | null = null;
  for (const line of code) {
    if (terminator !== null) {
      if (line.text.replace(/^\t+/, "").trimEnd() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.text);
    if (!m) continue;
    const word = commandWord(line.text, scanCommand(line.text).seg[m.index]!);
    const after = line.text.slice(m.index + m[0].length);
    const redirected = /(^|[^0-9&<])>{1,2}\s*(?!&)/.test(line.text.slice(0, m.index) + after);
    const toTerminal = word === "cat" && !after.includes("|") && !redirected;
    if (toTerminal || MESSAGE_COMMAND.test(word)) terminator = m[2]!;
  }
  return out;
}

/** Index every character of a command with the simple command it belongs to. */
function scanCommand(t: string): Scan {
  interface Frame {
    start: number;
    quote: "" | "'" | '"';
    tick: boolean;
    proc: boolean;
  }
  const stack: Frame[] = [{ start: 0, quote: "", tick: false, proc: false }];
  const seg: number[] = [];
  const depth: number[] = [];
  const proc: boolean[] = [];
  const comment: boolean[] = [];
  let inComment = false;
  const mark = (i: number) => {
    const top = stack[stack.length - 1]!;
    seg[i] = top.start;
    depth[i] = stack.length - 1;
    proc[i] = stack.some((f) => f.proc);
    comment[i] = inComment;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inComment && c === "\n") inComment = false;
    mark(i);
    if (inComment) continue;
    const top = stack[stack.length - 1]!;
    if (top.quote === "'") {
      if (c === "'") top.quote = "";
      continue;
    }
    if (c === "\\") {
      if (i + 1 < t.length) mark(++i);
      continue;
    }
    if (c === "$" && t[i + 1] === "(") {
      stack.push({ start: i + 2, quote: "", tick: false, proc: false });
      mark(++i);
      continue;
    }
    if (c === "`") {
      if (top.tick && stack.length > 1) stack.pop();
      else stack.push({ start: i + 1, quote: "", tick: true, proc: false });
      continue;
    }
    if (top.quote === '"') {
      if (c === '"') top.quote = "";
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(t[i - 1]!))) {
      inComment = comment[i] = true;
    } else if (c === "'" || c === '"') {
      top.quote = c;
    } else if (c === "(") {
      stack.push({ start: i + 1, quote: "", tick: false, proc: t[i - 1] === "<" });
    } else if (c === ")") {
      if (stack.length > 1) stack.pop();
      else top.start = seg[i] = i + 1;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      // The separator closes the command before it, so segmentEnd stops on it.
      top.start = seg[i] = i + 1;
    }
  }
  return { seg, depth, proc, comment };
}

/** Where the simple command starting at `start` ends. */
function segmentEnd(sc: Scan, start: number): number {
  const d = sc.depth[start] ?? 0;
  let j = start;
  while (j < sc.seg.length && (sc.depth[j]! > d || (sc.depth[j] === d && sc.seg[j] === start))) j++;
  return j;
}

/**
 * The command name of the simple command starting at `start`, past `sudo`
 * and its options, control keywords and leading assignments, reduced to its
 * basename (`/bin/bash` is `bash`). Returns its end index too.
 */
function commandAt(t: string, start: number): { word: string; end: number } {
  const re = /[\s\\]*("[^"]*"|'[^']*'|[^\s;|&()]+)/y;
  re.lastIndex = start;
  let wrapped = false;
  let skipNext = false;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const tok = m[1]!;
    const bare = tok.replace(/^["']|["']$/g, "");
    const name = bare.replace(/^.*\/(?=[^/])/, "");
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (/^(sudo|doas|env|exec|nohup)$/.test(name) || /^\$\{?SUDO\}?$/.test(bare)) {
      wrapped = true;
      continue;
    }
    if (wrapped && bare.startsWith("-")) {
      skipNext = /^-[ugCprtTUD]$/.test(bare);
      continue;
    }
    if (
      /^(!|\{|then|do|else|elif|if|while|until|time)$/.test(bare) ||
      /^[A-Za-z_][A-Za-z0-9_]*=[^"'`$]*$/.test(tok)
    ) {
      continue;
    }
    return { word: name, end: re.lastIndex };
  }
  return { word: "", end: t.length };
}

function commandWord(t: string, start: number): string {
  return commandAt(t, start).word;
}

function isMessage(t: string, start: number): boolean {
  return MESSAGE_COMMAND.test(commandWord(t, start));
}

function lineAt(cmd: Command, index: number): Line {
  const n = cmd.text.slice(0, index).split("\n").length - 1;
  return cmd.lines[Math.min(n, cmd.lines.length - 1)]!;
}

function classifyFetches(commands: Command[], code: Line[]) {
  const downloads = new Map<number, Line>();
  const payload = new Map<number, Line>();
  const metadata = new Map<number, Line>();
  const delegated = new Map<number, { line: Line; manager: string }>();
  const allText = code.map((l) => l.text).join("\n");

  for (const cmd of commands) {
    const t = cmd.text;
    const sc = scanCommand(t);

    for (const m of t.matchAll(new RegExp(DOWNLOAD.source, "g"))) {
      const i = m.index!;
      const start = sc.seg[i]!;
      if (sc.comment[i] || isMessage(t, start)) continue;
      if (PROBES_TOOL.test(t.slice(start, i)) || /^\s+(-V|--version)\b/.test(t.slice(i + m[1]!.length))) continue;
      const line = lineAt(cmd, i);
      downloads.set(line.n, line);
      const kind = fetchKind(t, sc, i, m[1]!, allText);
      (kind === "payload" ? payload : metadata).set(line.n, line);
    }

    for (const start of new Set(sc.seg)) {
      if (sc.comment[start]) continue;
      const pm = packageManagerInstall(t, sc, start, allText);
      if (!pm) continue;
      const line = lineAt(cmd, start);
      if (pm === "unregistered") {
        payload.set(line.n, line);
        downloads.set(line.n, line);
      } else {
        delegated.set(line.n, { line, manager: pm });
      }
    }
  }

  // A line that both reads metadata and fetches a payload is a payload line.
  for (const n of payload.keys()) metadata.delete(n);
  const byLine = <T>(m: Map<number, T>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  return {
    downloads: byLine(downloads),
    payload: byLine(payload),
    metadata: byLine(metadata),
    delegated: byLine(delegated),
  };
}

function fetchKind(
  t: string,
  sc: Scan,
  i: number,
  tool: string,
  allText: string,
): "payload" | "metadata" {
  const start = sc.seg[i]!;
  const end = segmentEnd(sc, start);
  const args = t.slice(i + tool.length, end);

  if (sc.proc[i]) return "payload"; // bash <(curl ...), source <(curl ...)
  if (writesFile(tool, args)) return "payload";

  const piped = pipelineKind(t, sc, end);
  if (piped === "payload") return "payload";

  if ((sc.depth[i] ?? 0) > 0) {
    // Captured by $(...). Run directly by its outer command, or captured into
    // a variable the script later evaluates, it is still a payload.
    const open = start - 2;
    const outerStart = sc.seg[open] ?? 0;
    const prefix = t.slice(outerStart, open);
    const assigned = /(?:^|\s)(?:local\s+|export\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?$/.exec(prefix);
    if (assigned) return evaluatesVar(allText, assigned[1]!) ? "payload" : "metadata";
    if (CONSUMES_PAYLOAD.test(commandWord(t, outerStart))) return "payload";
    return pipelineKind(t, sc, segmentEnd(sc, outerStart)) === "payload" ? "payload" : "metadata";
  }
  return piped === "metadata" ? "metadata" : "payload";
}

/**
 * What the pipeline after the command ending at `end` does with its input.
 * One consumer that runs, extracts or writes what it receives makes it a
 * payload. Only a pipeline made entirely of parsers (jq, grep, node -e) reads
 * metadata; any other consumer is presumed to keep what it was given.
 */
function pipelineKind(t: string, sc: Scan, end: number): "payload" | "metadata" | "none" {
  let consumers = 0;
  for (let k = end; t[k] === "|" && t[k + 1] !== "|"; ) {
    const { word, end: wordEnd } = commandAt(t, k + 1);
    const segEnd = segmentEnd(sc, k + 1);
    consumers++;
    const parses = /^(python3?|node|perl|ruby)$/.test(word) && PARSES_STDIN.test(t.slice(wordEnd));
    if ((CONSUMES_PAYLOAD.test(word) && !parses) || redirectsToFile(t.slice(wordEnd, segEnd))) return "payload";
    if (!parses && !PARSES_TEXT.test(word)) return "payload";
    k = segEnd;
  }
  return consumers > 0 ? "metadata" : "none";
}

function redirectsToFile(args: string): boolean {
  return /(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[^\s]/.test(args) || /(^|\s)of=/.test(args);
}

function writesFile(tool: string, args: string): boolean {
  if (redirectsToFile(args)) return true;
  switch (tool) {
    case "curl":
      return /(^|\s)(-[A-Za-z]*[oO]|--output|--remote-name|--output-dir)(?=[\s="'$]|$)/.test(args);
    case "wget":
      return !/(^|\s)(-[A-Za-z]*O\s*-|--output-document=?\s*-)(\s|$)/.test(args);
    case "aria2c":
      return true;
    default:
      return /-OutFile\b/i.test(args);
  }
}

function evaluatesVar(allText: string, name: string): boolean {
  const ref = `\\$\\{?${name}\\b`;
  return [
    new RegExp(`\\beval\\b[^\\n]*${ref}`),
    new RegExp(`\\b(ba|z|da|k)?sh\\s+-c\\s+[^\\n]*${ref}`),
    new RegExp(`${ref}\\}?["']?\\s*\\|\\s*(sudo\\s+)?(\\$\\{?SUDO\\}?\\s+)?(ba|z|da|k)?sh\\b`),
  ].some((re) => re.test(allText));
}

/**
 * The package manager a simple command installs through, "unregistered" when
 * it installs a URL or archive directly (no registry hash applies), or null.
 */
function packageManagerInstall(t: string, sc: Scan, start: number, allText: string): string | "unregistered" | null {
  const { word, end } = commandAt(t, start);
  const rest = t.slice(end, segmentEnd(sc, start));
  let manager = word;
  let args = rest;
  const viaModule = /^\s+-m\s+(pip)\b/.exec(rest);
  if (/^python3?$/.test(word) && viaModule) {
    manager = "pip";
    args = rest.slice(viaModule[0].length);
  }
  const verbs = PACKAGE_MANAGERS[manager];
  if (!verbs) return null;

  let verb = positionalArgs(args).join(" ");
  // `npm "${install_args[@]}"`: the verb lives in the array's assignment.
  const expanded = /^["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)(\[@\])?\}?/.exec(verb);
  if (expanded) {
    const assignment = new RegExp(`\\b${expanded[1]}\\+?=\\(?\\s*["']?([^\\n)]*)`).exec(allText);
    if (!assignment) return null;
    verb = assignment[1]!;
  }
  if (!verbs.test(verb)) return null;
  if (UNREGISTERED_ARTEFACT.test(args)) return "unregistered";
  if (NPM_FAMILY.test(manager) && namesHostedShorthand(args)) return "unregistered";
  return manager;
}

/** Env var names that look like they carry a credential. */
export function credentialShaped(names: string[]): string[] {
  return names.filter((n) =>
    /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SESSION)/.test(n),
  );
}
