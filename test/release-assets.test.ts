import { describe, expect, it } from "vitest";
import { CHECKSUM_ASSET } from "../src/collect/index";

/**
 * Regression test for the bug that mattered most.
 *
 * The first version of this pattern anchored the whole filename, so
 * `sha256sum.txt` did not match. Running the pipeline against ollama/ollama
 * therefore reported "the installer verifies nothing" but silently dropped the
 * sharper half of the finding: that the release publishes the checksums the
 * installer ignores. That is the single most reproducible result in the
 * validation report, and it was missing.
 *
 * Asset names are taken from real releases.
 */
describe("release integrity assets", () => {
  it("recognises the names projects actually use", () => {
    const real = [
      "sha256sum.txt",
      "checksums.txt",
      "SHA256SUMS",
      "sha256sums",
      "checksums_sha256.txt",
      "uv-x86_64-unknown-linux-gnu.tar.gz.sha256",
      "release.tar.gz.sig",
      "release.tar.gz.asc",
      "app.minisig",
      "provenance.intoto.jsonl",
      "multiple.intoto.jsonl",
    ];
    for (const name of real) {
      expect(CHECKSUM_ASSET.test(name), name).toBe(true);
    }
  });

  it("does not mistake an ordinary release artefact for an integrity file", () => {
    const artefacts = [
      "ollama-darwin.tgz",
      "ollama-linux-amd64.tar.zst",
      "Ollama.dmg",
      "OllamaSetup.exe",
      "install.sh",
      "install.ps1",
      "uv-aarch64-apple-darwin.tar.gz",
      "source.zip",
    ];
    for (const name of artefacts) {
      expect(CHECKSUM_ASSET.test(name), name).toBe(false);
    }
  });
});
