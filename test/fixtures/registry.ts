/**
 * Registry documents recorded from registry.npmjs.org, trimmed to the fields
 * fetchNpm reads.
 *
 * REA_AGENTS is rea-agents as the registry served it on 2026-10-17, with
 * 6.5.0 the latest version: a SLSA provenance attestation under
 * dist.attestations and an _npmUser carrying npm's trusted-publisher record.
 * REA_AGENTS_TOKEN_PUBLISHED is the same entry as a package published with a
 * personal token would look: no attestations, no trustedPublisher.
 */
export const REA_AGENTS = {
  name: "rea-agents",
  "dist-tags": { latest: "6.5.0" },
  maintainers: [{ name: "morluto", email: "morluto@hotmail.com" }],
  repository: { url: "git+https://github.com/morluto/rea.git", type: "git" },
  versions: {
    "6.5.0": {
      name: "rea-agents",
      version: "6.5.0",
      repository: { url: "git+https://github.com/morluto/rea.git", type: "git" },
      bin: { rea: "scripts/rea.mjs", "rea-agents": "scripts/rea.mjs" },
      scripts: { prepack: "node scripts/prepack.mjs", prepare: "node scripts/prepare.mjs" },
      _npmUser: {
        name: "GitHub Actions",
        email: "npm-oidc-no-reply@github.com",
        trustedPublisher: {
          id: "github",
          oidcConfigId: "55284132-3079-4ea8-8df7-7f2d6893ac14",
        },
      },
      dist: {
        shasum: "7ea5e6f669bc18c45dbf5dba653edaa1ada07ab3",
        tarball: "https://registry.npmjs.org/rea-agents/-/rea-agents-6.5.0.tgz",
        fileCount: 1650,
        integrity:
          "sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==",
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/rea-agents@6.5.0",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    },
  },
};

export const REA_AGENTS_TOKEN_PUBLISHED = {
  ...REA_AGENTS,
  versions: {
    "6.5.0": {
      ...REA_AGENTS.versions["6.5.0"],
      _npmUser: { name: "morluto", email: "morluto@hotmail.com" },
      dist: {
        shasum: REA_AGENTS.versions["6.5.0"].dist.shasum,
        tarball: REA_AGENTS.versions["6.5.0"].dist.tarball,
        integrity: REA_AGENTS.versions["6.5.0"].dist.integrity,
      },
    },
  },
};
