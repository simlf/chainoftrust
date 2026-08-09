/**
 * Clamp a target-controlled name to something safe to place in a statement.
 *
 * A finding statement is ours and travels in the part of the write-up prompt
 * the system prompt attributes to the sender, so anything the target chose has
 * to arrive as a name and not as prose. Paths, hosts, package names, accounts,
 * release assets, environment variables and hook events are all names the
 * target picks, and a name is allowed to be a name: what is not allowed is a
 * sentence wearing one.
 *
 * Whitespace is removed rather than collapsed and anything outside a plain
 * identifier set is dropped, so an injected sentence arrives as unreadable run
 * together tokens instead of an instruction, while an ordinary path such as
 * docs/install.sh or a scoped package name passes through unchanged. Verbatim
 * target text belongs in a finding's quote, which travels inside the nonce
 * fence.
 */
const MAX_LABEL = 64;

export function label(raw: string): string {
  const clamped = raw
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9._@/:+-]/g, "")
    .slice(0, MAX_LABEL);
  return clamped || "(unnamed)";
}

export function labelList(values: string[], max = 6): string {
  const shown = values.slice(0, max).map(label);
  return shown.join(", ");
}
