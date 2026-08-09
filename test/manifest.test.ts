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
