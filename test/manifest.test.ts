import { describe, expect, it } from "vitest";
import { analysePackageJson, analysePyproject } from "../src/collect/manifest";

describe("package manifest", () => {
  it("reports lifecycle scripts as one finding inside the install path", () => {
    const findings = analysePackageJson(
      "package.json",
      JSON.stringify({ scripts: { postinstall: "node scripts/setup.js" } }),
    );
    const lifecycle = findings.filter(
      (f) => f.concern === "install-path:lifecycle-scripts",
    );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]!.check).toBe("install-path");
    expect(lifecycle[0]!.severity).toBe("warning");
    expect(lifecycle[0]!.statement).toContain("postinstall");
  });

  it("states the negative case, which is the common one", () => {
    const findings = analysePackageJson("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    expect(findings.find((f) => f.concern === "install-path:lifecycle-scripts")?.severity).toBe(
      "clean",
    );
  });

  it("names the executables the package puts on PATH", () => {
    const findings = analysePackageJson(
      "package.json",
      JSON.stringify({ bin: { uv: "./bin/uv.js", uvx: "./bin/uvx.js" } }),
    );
    const executables = findings.find((f) => f.concern === "install-path:executables");
    expect(executables?.statement).toContain("uv, uvx");
  });

  it("says nothing at all about a manifest it cannot parse", () => {
    expect(analysePackageJson("package.json", "{ not json")).toEqual([]);
  });

  it("says nothing about a manifest that parses to something other than an object", () => {
    // A repository whose package.json holds the four bytes null used to throw a
    // TypeError out of the collector and render the 500 page. Target content is
    // untrusted input and must never choose the response.
    for (const source of ["null", '"text"', "42", "[]", "true"]) {
      expect(() => analysePackageJson("package.json", source), source).not.toThrow();
      expect(analysePackageJson("package.json", source), source).toEqual([]);
    }
  });

  it("tolerates a manifest whose fields are the wrong shape", () => {
    expect(() =>
      analysePackageJson("package.json", JSON.stringify({ scripts: "nope", bin: 7 })),
    ).not.toThrow();
  });

  it("reports the Python build backend that a pip install would run", () => {
    const findings = analysePyproject(
      "pyproject.toml",
      '[build-system]\nbuild-backend = "hatchling.build"\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.statement).toContain("hatchling.build");
    expect(analysePyproject("pyproject.toml", "[project]\nname = 'x'\n")).toEqual([]);
  });
});
