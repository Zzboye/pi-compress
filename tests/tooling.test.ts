import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { execSync } from "node:child_process";
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
    const d1 = fs.readFileSync(join(root, "e2e", "rpc-driver.mjs"), "utf8");
    const d2 = fs.readFileSync(join(root, "e2e", "rpc-driver2.mjs"), "utf8");
    // 独有能力必须真实存在，否则该文件与 driver1 重复，应删除。
    // 注意：driver1 的 `--session-dir` 含 `--session` 子串，故用带空格/变量的完整形式判定。
    for (const capability of ["--session ${", "round(", "statusOnce("]) {
      expect(d2, `rpc-driver2.mjs 应含 ${capability}`).toContain(capability);
    }
    for (const capability of ["round(", "statusOnce("]) {
      expect(d1, `rpc-driver.mjs 不应含 ${capability}（否则两者重复）`).not.toContain(capability);
    }
  });

  it("e2e/reports 已 gitignore（bench 输出不脏工作区）", () => {
    expect(fs.readFileSync(join(root, ".gitignore"), "utf8")).toContain("e2e/reports/");
  });
});

describe("e2e 产物与 bench fixture 分离", () => {
  it("bench 输入 fixture 位于 bench/fixtures/ 且未被 gitignore（新克隆可跑）", () => {
    const fx = join(root, "bench", "fixtures", "2026-09-05-current-context-dump.md");
    expect(fs.existsSync(fx), "fixture 应存在于 bench/fixtures/").toBe(true);
    // git check-ignore：exit 0 = 被忽略（坏），exit 1 = 未忽略（好）
    let ignored = true;
    try {
      execSync(`git check-ignore -q "bench/fixtures/2026-09-05-current-context-dump.md"`, { cwd: root, stdio: "ignore" });
    } catch (e: any) {
      ignored = e.status === 0 ? true : false;
    }
    expect(ignored, "bench fixture 不应被 gitignore").toBe(false);
  });

  it("e2e/reports/ 下无已跟踪文件（产物只落本地，不脏仓库）", () => {
    const tracked = execSync("git ls-files e2e/reports", { cwd: root, encoding: "utf8" }).trim();
    expect(tracked).toBe("");
  });
});
