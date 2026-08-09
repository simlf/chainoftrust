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
 * Whitespace is removed rather than collapsed and anything outside the plain
 * identifier set is dropped, so an injected sentence arrives as unreadable run
 * together tokens instead of an instruction, while an ordinary path such as
 * docs/install.sh, a scoped package name, or a PEP 440 version such as 1!2.0
 * passes through unchanged. Verbatim target text belongs in a finding's quote,
 * which travels inside the nonce fence.
 *
 * A name that had to be changed is marked. The publication rule is a verifiable
 * fact with a citation, and a silently shortened path is neither: a reader
 * would go looking for a file that is not there.
 */
const MAX_LABEL = 160;

/** The characters a path, a package name and a PEP 440 version need. */
const SAFE = /[^A-Za-z0-9._@/:+!~-]/g;

const CLAMPED_MARK = " (name shortened)";

export function label(raw: string): string {
  const safe = raw.replace(/\s+/g, "").replace(SAFE, "");
  const clamped = safe.slice(0, MAX_LABEL);
  if (!clamped) return "(a name this report cannot render)";
  return clamped === raw ? clamped : `${clamped}${CLAMPED_MARK}`;
}

export function labelList(values: string[], max = 6): string {
  return values.slice(0, max).map(label).join(", ");
}
