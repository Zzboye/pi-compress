import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("工程配置", () => {
  it("vitest.config.ts 只收 tests/ 下的用例（bench 不混入 npm test）", () => {
    const cfg = fs.readFileSync(join(root, "vitest.config.ts"), "utf8");
    expect(cfg).toContain("tests/**/*.test.ts");
  });

  it("vitest.bench.config.ts 只收 bench/ 下的用例", () => {
    const cfg = fs.readFileSync(join(root, "vitest.bench.config.ts"), "utf8");
    expect(cfg).toContain("bench/**/*.test.ts");
  });

  it("package.json 提供 test / test:bench / typecheck", () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:bench"]).toContain("bench");
    expect(pkg.scripts.typecheck).toContain("tsc");
  });

  it("CI workflow 存在且含 typecheck 与 test 步骤", () => {
    const wf = fs.readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(wf).toContain("npm ci");
    expect(wf).toContain("npm run typecheck");
    expect(wf).toContain("npm test");
  });

  it("重复/一次性脚本已清理", () => {
    for (const p of ["scripts/_turnsize.mjs", "scripts/_asmstats.mjs", "scripts-dump-context.mjs"]) {
      expect(fs.existsSync(join(root, p)), `${p} 应已删除`).toBe(false);
    }
  });

  it("e2e/rpc-driver2.mjs 保留（含 rpc-driver.mjs 没有的续接会话/装配·召回状态解析能力）", () => {
    expect(fs.existsSync(join(root, "e2e", "rpc-driver2.mjs"))).toBe(true);
    expect(fs.existsSync(join(root, "e2e", "rpc-driver.mjs"))).toBe(true);
  });

  it("e2e/reports 已 gitignore（bench 输出不脏工作区）", () => {
    expect(fs.readFileSync(join(root, ".gitignore"), "utf8")).toContain("e2e/reports/");
  });
});
