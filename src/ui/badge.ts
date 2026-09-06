import type { Verdict } from "../types";
import { VERDICT_LABEL } from "../verdict/score";
import { esc } from "./layout";

/**
 * The embeddable verdict badge, drawn deterministically from the same
 * verdict tier the chain-of-trust drawing reads (`pages.ts`'s `chainOfTrust`),
 * never from a fresh read of anything else. Shields-style two-segment shape,
 * but in the product's own register: monospace, flat, the same tier colours
 * as the report stamp (`layout.ts`'s `--ok`/`--warn`/`--crit`) rather than
 * shields' green/red.
 *
 * System monospace only, no `@font-face`: this SVG is served standalone and
 * embedded cross-origin as a plain `<img>`, where a same-origin font file
 * would not reliably load.
 */
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CHAR_WIDTH = 6.2;
const H_PAD = 6;
const HEIGHT = 20;

const LABEL_BG = "#0a2942";
const LABEL_TEXT = "#e8f2fb";
const MESSAGE_TEXT = "#0a2942";

const TIER_COLOR: Record<Verdict, string> = {
  clean: "#9ff0c8",
  warnings: "#ffd27a",
  "do-not-install": "#ff9d8a",
};

const NOT_ANALYSED_COLOR = "#9dc0da";
const NOT_ANALYSED_MESSAGE = "not analyzed";

function segmentWidth(text: string): number {
  return Math.round(text.length * CHAR_WIDTH + H_PAD * 2);
}

function segment(x: number, width: number, fill: string, textColor: string, text: string): string {
  return `<g>
<rect x="${x}" y="0" width="${width}" height="${HEIGHT}" fill="${fill}"/>
<text x="${x + width / 2}" y="14" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="0.3" fill="${textColor}" text-anchor="middle">${esc(text)}</text>
</g>`;
}

/**
 * `href` is where the badge's own `<a>` points when the SVG is opened on its
 * own rather than embedded as an `<img>` (an `<img>` cannot follow a link
 * baked into the image it displays; the README embed snippet supplies the
 * click target for that case by wrapping the `<img>` in a markdown link).
 */
export function badgeSvg(opts: { verdict: Verdict; href: string } | { href: string }): string {
  const label = "chainoftrust";
  const isVerdict = "verdict" in opts;
  const message = isVerdict ? VERDICT_LABEL[opts.verdict].toLowerCase() : NOT_ANALYSED_MESSAGE;
  const fill = isVerdict ? TIER_COLOR[opts.verdict] : NOT_ANALYSED_COLOR;

  const labelWidth = segmentWidth(label);
  const messageWidth = segmentWidth(message);
  const total = labelWidth + messageWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${total}" height="${HEIGHT}" viewBox="0 0 ${total} ${HEIGHT}" role="img" aria-label="${esc(`${label}: ${message}`)}">
<a xlink:href="${esc(opts.href)}">
${segment(0, labelWidth, LABEL_BG, LABEL_TEXT, label)}
${segment(labelWidth, messageWidth, fill, MESSAGE_TEXT, message)}
</a>
</svg>`;
}

/** The stable, repo-scoped route a README embeds. Never pinned to a commit. */
export function badgePath(owner: string, name: string): string {
  return `/badge/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.svg`;
}
