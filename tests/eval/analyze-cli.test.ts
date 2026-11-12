import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "review-pi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAnalyzeTokenArgs } from "../../scripts/analyze-token.js";
import { record, snapshot } from "./fixtures.js";

/**
 * analyze-token 单命令（#51）报告缝 + 进程缝：
 * - 三种输入形态（单记录 / 实验目录 / runs 根 + experimentId）；
 * - JSON / Markdown 双产物、确定性、历史记录可读、缺字段 N/A；
 * - 零网络、零密钥（哨兵值不得出现在任何输出面）。
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSC_BIN = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const CLI_JS = path.join(REPO_ROOT, ".tmp-gen", "scripts", "analyze-token.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRecordFile(
  root: string,
  caseId: string,
  configId: RunRecord["configId"],
  rep: number,
  overrides: Parameters<typeof record>[0] = {},
): string {
  const file = path.join(root, "runs", "vul4j", caseId, configId, `rep-${rep}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record({ caseId, configId, rep, ...overrides }), null, 2)}\n`, "utf8");
  return file;
}

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120_000,
  });
}

describe("parseAnalyzeTokenArgs", () => {
  it("三种输入形态均可解析", () => {
    expect(parseAnalyzeTokenArgs(["--record", "r.json"])).toMatchObject({
      ok: true,
      options: { input: { kind: "record", path: "r.json" } },
    });
    expect(parseAnalyzeTokenArgs(["--experiment=exp"])).toMatchObject({
      ok: true,
      options: { input: { kind: "experiment", path: "exp" } },
    });
    expect(parseAnalyzeTokenArgs(["--runs-root", "runs", "--experiment-id", "e1"])).toMatchObject({
      ok: true,
      options: { input: { kind: "runs", runsRoot: "runs", experimentId: "e1" } },
    });
  });

  it("输入形态互斥；runs-root 与 experiment-id 必须成对", () => {
    expect(parseAnalyzeTokenArgs([]).ok).toBe(false);
    expect(parseAnalyzeTokenArgs(["--record", "r.json", "--experiment", "exp"]).ok).toBe(false);
    expect(parseAnalyzeTokenArgs(["--runs-root", "runs"]).ok).toBe(false);
    expect(parseAnalyzeTokenArgs(["--experiment-id", "e1"]).ok).toBe(false);
  });

  it("--help / 未知旗标返回用法错误", () => {
    expect(parseAnalyzeTokenArgs(["--help"]).ok).toBe(false);
    expect(parseAnalyzeTokenArgs(["--nope"]).ok).toBe(false);
  });
});

describe("analyze-token 进程级", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [TSC_BIN, "-p", "tsconfig.analyze-token.json"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 180_000);

  it("三种输入形态产出相同报告字节；同一输入两次运行输出字节相同", () => {
    const root = makeTempDir("analyze-token-modes-");
    const recordFile = writeRecordFile(root, "VUL4J-1", "E", 1, {
      baseline: snapshot({
        usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
      }),
    });
    const experimentDir = path.join(root, "exp");
    writeRecordFile(experimentDir, "VUL4J-1", "E", 1, {
      baseline: snapshot({
        usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
      }),
    });

    const outs = ["single", "experiment", "runs", "single-again"].map((name) =>
      path.join(root, `out-${name}`),
    );
    const commands: readonly (readonly string[])[] = [
      ["--record", recordFile, "--out", outs[0] as string],
      ["--experiment", experimentDir, "--out", outs[1] as string],
      ["--runs-root", root, "--experiment-id", "exp", "--out", outs[2] as string],
      ["--record", recordFile, "--out", outs[3] as string],
    ];
    for (const args of commands) {
      const result = runCli(args);
      expect(result.status, result.stderr).toBe(0);
    }

    const read = (dir: string, name: string) => readFileSync(path.join(dir, name), "utf8");
    const json = outs.map((dir) => read(dir, "token-analysis.json"));
    const markdown = outs.map((dir) => read(dir, "token-analysis.md"));
    expect(json[1]).toBe(json[0]);
    expect(json[2]).toBe(json[0]);
    expect(json[3]).toBe(json[0]);
    expect(markdown[1]).toBe(markdown[0]);
    expect(markdown[2]).toBe(markdown[0]);
    expect(markdown[3]).toBe(markdown[0]);

    const report = JSON.parse(json[0] as string) as {
      schemaVersion: number;
      currency: string | null;
      priceValidFrom: string | null;
      summary: { cost: { carc: { mean: number } } };
      runs: readonly { cost: { cachedInputTokens: number | null } }[];
    };
    expect(report.schemaVersion).toBe(2);
    expect(report.currency).toBeNull();
    expect(report.priceValidFrom).toBeNull();
    expect(report.runs[0]?.cost.cachedInputTokens).toBe(600);
    expect(report.summary.cost.carc.mean).toBe(500);
    expect(markdown[0]).toContain("- currency: N/A");
    expect(markdown[0]).toContain("## 四行主表");
  });

  it("历史记录缺缓存 / retry / summary 字段仍可读，对应列为 null；--pricing 回显 currency", () => {
    const root = makeTempDir("analyze-token-null-");
    const recordFile = writeRecordFile(root, "VUL4J-2", "A", 1, {
      baseline: snapshot({ usage: { inputTokens: 8502, outputTokens: 10348 } }),
    });
    const pricingFile = path.join(root, "pricing.json");
    writeFileSync(
      pricingFile,
      JSON.stringify({
        currency: "CNY",
        priceValidFrom: "2026-11-01T00:00:00Z",
        cacheHitPrice: 0.1,
        cacheMissPrice: 1,
        outputPrice: 2,
      }),
      "utf8",
    );
    const out = path.join(root, "out");
    const result = runCli(["--record", recordFile, "--pricing", pricingFile, "--out", out]);
    expect(result.status, result.stderr).toBe(0);

    const report = JSON.parse(readFileSync(path.join(out, "token-analysis.json"), "utf8")) as {
      currency: string | null;
      priceValidFrom: string | null;
      runs: readonly {
        cost: {
          cachedInputTokens: number | null;
          retryCostTokens: number | null;
          summaryCostTokens: number | null;
          carc: number;
        };
        loop: { skippedToolCalls: number };
      }[];
    };
    expect(report.currency).toBe("CNY");
    expect(report.priceValidFrom).toBe("2026-11-01T00:00:00Z");
    expect(report.runs[0]?.cost).toMatchObject({
      cachedInputTokens: null,
      retryCostTokens: null,
      summaryCostTokens: null,
      carc: 18850,
    });
    expect(report.runs[0]?.loop.skippedToolCalls).toBe(0);
    expect(readFileSync(path.join(out, "token-analysis.md"), "utf8")).toContain("- currency: CNY");
  });

  it("不读密钥、不发起网络：哨兵环境变量不出现在任何输出面", () => {
    const root = makeTempDir("analyze-token-sentinel-");
    const recordFile = writeRecordFile(root, "VUL4J-3", "E", 1);
    const out = path.join(root, "out");
    const sentinel = "sk-analyze-token-sentinel-9c1f";
    const result = runCli(["--record", recordFile, "--out", out], {
      REVIEWER_API_KEY: sentinel,
      DEEPSEEK_API_KEY: sentinel,
      REVIEWER_URL: "http://127.0.0.1:1/v1",
    });
    expect(result.status, result.stderr).toBe(0);

    const surfaces = [
      result.stdout,
      result.stderr,
      readFileSync(path.join(out, "token-analysis.json"), "utf8"),
      readFileSync(path.join(out, "token-analysis.md"), "utf8"),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(sentinel);
    }

    const source = readFileSync(path.join(REPO_ROOT, "scripts", "analyze-token.ts"), "utf8");
    for (const forbidden of [
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "fetch(",
      "process.env",
      "review-llm",
      "runReview",
    ]) {
      expect(source, `analyze-token must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
