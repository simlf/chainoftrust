/**
 * Condensed reconstructions of the install-path shapes found by the two audits
 * this project treats as seed material:
 *
 *   data/cot-validate/report.md        the 8-repository validation, 2026-08-09
 *   data/learnings.md                  the *-axi / no-mistakes / treehouse
 *                                      toolchain audit, 2026-08-08
 *
 * These are not verbatim copies of anyone's installer. Each keeps only the
 * control-flow shape that made the original finding, so that a change to the
 * analyser which stops detecting it fails a test rather than silently
 * regressing the product's sharpest check.
 */

/** uv: checksum baked in at release-build time, compared, aborts on mismatch. */
export const VERIFIES_AND_ABORTS = `#!/bin/sh
set -e

_install_dir="\${HOME}/.local/bin"
_url="https://releases.astral.sh/uv/uv-x86_64-unknown-linux-gnu.tar.gz"
_checksum_style="sha256"
_checksum_value="546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843"

download() {
  curl -fsSL "$_url" -o "$_file"
}

verify_checksum() {
  if [ -z "$_checksum_style" ]; then
    say "no checksums to verify"
    return 0
  fi
  _calculated_checksum="$(sha256sum -b "$_file" | awk '{printf $1}')"
  if [ "$_calculated_checksum" != "$_checksum_value" ]; then
    err "checksum mismatch for $_file"
    exit 1
  fi
}

download
verify_checksum
ln -sf "$_file" "$_install_dir/uv"
`;

/**
 * aider: the same generated installer, frozen ~20 months earlier. The checksum
 * variables are read but never assigned anywhere, so the comparison can only
 * take the branch that skips verification. Dead code, not a policy choice.
 */
export const VERIFICATION_UNREACHABLE = `#!/bin/sh
set -e

_url="https://aider.chat/dist/uv-x86_64-unknown-linux-gnu.tar.gz"

download() {
  curl -fsSL "$_url" -o "$_file"
}

verify_checksum() {
  if [ -z "$_checksum_style" ]; then
    say "no checksums to verify"
    return 0
  fi
  _calculated_checksum="$(sha256sum -b "$_file" | awk '{printf $1}')"
  if [ "$_calculated_checksum" != "$_checksum_value" ]; then
    err "checksum mismatch"
    exit 1
  fi
}

select_archive() {
  case "$_arch" in
    x86_64-unknown-linux-gnu) _artifact_name="uv-x86_64-unknown-linux-gnu.tar.gz" ;;
    aarch64-apple-darwin)     _artifact_name="uv-aarch64-apple-darwin.tar.gz" ;;
  esac
}

select_archive
download
verify_checksum
ensure "\${_install_dir}/uv" tool install --force --with pip aider-chat@latest
`;

/**
 * Ollama: the release publishes sha256sum.txt and the installer never names
 * it. Extracts as root, creates a system user, writes and enables a systemd
 * unit that runs the unverified binary, and adds a third-party package repo.
 */
export const NO_VERIFICATION_WITH_DAEMON = `#!/bin/sh
set -eu

status() { echo ">>> $*" >&2; }

SUDO=
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

BINDIR=/usr/local/bin

status "Downloading Linux \${ARCH} bundle"
curl --fail --show-error --location --progress-bar \\
  "https://ollama.com/download/ollama-linux-\${ARCH}.tgz" | \\
  $SUDO tar -xzf - -C "$OLLAMA_INSTALL_DIR"

$SUDO useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama
$SUDO usermod -a -G ollama "$(whoami)"

configure_systemd() {
  cat <<EOF | $SUDO tee /etc/systemd/system/ollama.service >/dev/null
[Service]
ExecStart=$BINDIR/ollama serve
Restart=always
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable ollama
  $SUDO systemctl restart ollama
}

install_cuda_driver_apt() {
  curl -fsSL -o cuda-keyring.deb "https://developer.download.nvidia.com/compute/cuda/repos/\${1}\${2}/\${ARCH}/cuda-keyring_1.1-1_all.deb"
  $SUDO dpkg -i cuda-keyring.deb
  $SUDO apt-get update -y
  $SUDO modprobe nvidia
}

configure_systemd
`;

/**
 * The shape from the 2026-08-08 toolchain audit: a release tarball fetched
 * with no verification at all, followed by starting a long-running daemon.
 *
 * Correction carried from 2026-08-09, verified on release v1.46.0: the earlier
 * note said the axi family sends no telemetry. That is true of the axi
 * packages; no-mistakes itself ships a telemetry host compiled into the binary,
 * and its self-update path does verify checksums even though docs/install.sh
 * does not. The gap is client-side and specific to this script.
 */
export const RELEASE_TARBALL_NO_VERIFY = `#!/usr/bin/env bash
set -euo pipefail

REPO="kunchenguid/no-mistakes"
INSTALL_DIR="\${HOME}/.local/bin"

detect_platform() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
}

download_release() {
  local url="https://github.com/\${REPO}/releases/latest/download/no-mistakes_\${OS}_\${ARCH}.tar.gz"
  curl -fsSL "$url" -o "$TMPDIR/release.tar.gz"
  tar -xzf "$TMPDIR/release.tar.gz" -C "$TMPDIR"
}

detect_platform
download_release
install -m 0755 "$TMPDIR/no-mistakes" "$INSTALL_DIR/no-mistakes"

"$INSTALL_DIR/no-mistakes" daemon restart
`;

/** An installer that writes agent configuration. The highest-privilege case. */
export const WRITES_AGENT_CONFIG = `#!/usr/bin/env bash
set -e

mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/settings.json" ]; then
  cat > "$HOME/.claude/settings.json" <<'EOF'
{"mcpServers": {"example": {"command": "npx", "args": ["example@alpha", "mcp", "start"]}}}
EOF
fi

cp -r ./skills "$HOME/.claude/skills"
cp ./hooks/hooks.json "$HOME/.claude/hooks.json"
npm install -g example@alpha
`;

/** Reads credentials from the environment while installing. */
export const READS_CREDENTIALS = `#!/bin/sh
set -e
AUTH_HEADER=""
if [ -n "\${UV_GITHUB_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer \${UV_GITHUB_TOKEN}"
fi
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  echo "using configured key" >/dev/null
fi
curl -fsSL -H "$AUTH_HEADER" "https://releases.astral.sh/uv/latest" -o "$_file"
`;
