import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P0 基线冻结与历史 provenance 机读守卫（#38 / ADR-0016 / ADR-0017）：
 * - E 基线快照 manifest 为活基线（live-baseline），tag / commit / 运行时口径齐全；
 * - runs/phase2-pi 历史 manifest 必须标 NOT_REPRODUCIBLE、只作证据，并指向活基线；
 * - runbook 必须引用 baseline ref（AC：评测 runbook 能引用 baseline ref）。
 *
 * 这是确定性 CI 的一部分：基线口径、未知字段的 null 语义、凭据边界与
 * 历史数据「不冒充活基线」在这里变红。
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = path.join(REPO_ROOT, "docs", "report", "token-eval");
const E_BASELINE = path.join(DOCS, "e-baseline.json");
const PHASE2_PI = path.join(DOCS, "phase2-pi-provenance.json");

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

function packageVersion(relativePath: string): string {
  return readJson(path.join(REPO_ROOT, relativePath)).version;
}

describe("E 基线快照 manifest（#38 AC1）", () => {
  const baseline = readJson(E_BASELINE);

  it("是活基线：live-baseline，未标 NOT_REPRODUCIBLE", () => {
    expect(baseline.kind).toBe("e-baseline-snapshot");
    expect(baseline.status).toBe("live-baseline");
    expect(baseline.notReproducible).toBe(false);
  });

  it("tag / commit 固定：baselineId 与 tag 同源，commit 为完整 sha", () => {
    expect(baseline.baselineId).toMatch(/^eval-e-baseline-\d{4}-\d{2}-\d{2}$/);
    expect(baseline.git.tag).toBe(baseline.baselineId);
    expect(baseline.git.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("运行时按生产口径 pin：Config E / 协议 v3", () => {
    expect(baseline.runtime.configId).toBe("E");
    expect(baseline.runtime.protocolVersion).toBe(3);
  });

  it("组件版本与仓库 package.json 单源一致（漂移即需重新冻基线）", () => {
    const components = baseline.runtime.components as Record<string, string>;
    expect(components["@earendil-works/pi-ai"]).toBe(packageVersion("packages/ai/package.json"));
    expect(components["@earendil-works/pi-agent-core"]).toBe(
      packageVersion("packages/agent/package.json"),
    );
    expect(components["@earendil-works/chord"]).toBe(packageVersion("packages/chord/package.json"));
    expect(components["@earendil-works/pi-telemetry"]).toBe(
      packageVersion("packages/telemetry/package.json"),
    );
    expect(components["review-llm"]).toBe(packageVersion("packages/review-llm/package.json"));
    expect(components["review-pi"]).toBe(packageVersion("packages/review-pi/package.json"));
    expect(components["reviewagent"]).toBe(packageVersion("packages/reviewagent/package.json"));
  });

  it("未知部署版本记 null，不写 0", () => {
    expect(baseline.model.actualDeployment).toBeNull();
  });

  it("重建说明可执行：install → build → verify 命令齐备", () => {
    expect(baseline.build.lockfile).toBe("pnpm-lock.yaml");
    const commands = (baseline.build.commands as string[]).join("\n");
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm build:pi");
    expect(commands).toContain("pnpm build:reviewagent");
    expect((baseline.build.verification as string[]).join("\n")).toContain("pnpm test");
  });
});

describe("phase2-pi 历史 provenance（#38 AC2）", () => {
  const provenance = readJson(PHASE2_PI);

  it("标 NOT_REPRODUCIBLE：只作证据，不作活基线", () => {
    expect(provenance.kind).toBe("historical-run-provenance");
    expect(provenance.notReproducible).toBe(true);
    expect(provenance.evidenceOnly).toBe(true);
    expect(provenance.status).not.toBe("live-baseline");
  });

  it("来源 commit / 可考时间窗 / 模型 / judge 齐备", () => {
    expect(provenance.git.commit).toMatch(/^[0-9a-f]{40}$/);
    const start = Date.parse(provenance.window.start);
    const end = Date.parse(provenance.window.end);
    expect(Number.isNaN(start)).toBe(false);
    expect(Number.isNaN(end)).toBe(false);
    expect(start).toBeLessThan(end);
    expect(provenance.model.requestedId).toBe("deepseek-v4-flash");
    expect(provenance.judge.model).toBe("glm-5-3-260814");
  });

  it("缺失的可复现条件记 null，不写 0 / 不臆造", () => {
    expect(provenance.model.actualDeployment).toBeNull();
    expect(provenance.judge.promptVersion).toBeNull();
    expect(provenance.judge.temperature).toBeNull();
    expect(provenance.judge.topP).toBeNull();
  });

  it("指向活基线：supersededBy 与 E baseline manifest 同源", () => {
    expect(provenance.supersededBy).toBe(readJson(E_BASELINE).baselineId);
  });

  it("锚点可考：数据 hash 为 sha256，规模与复算口径明确", () => {
    expect(provenance.dataset.casesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.dataset.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.scale.runRecords).toBe(450);
    expect(provenance.scale.judgeRecords).toBe(450);
    expect(provenance.recompute.analyzer).toBe("src/eval/analysis (#37)");
    expect(provenance.recompute.matchesDashboard).toBe(true);
  });
});

describe("评测 runbook（#38 AC3）", () => {
  it("RUNBOOK 引用活基线 ref，并声明历史数据不作活基线", () => {
    const runbook = readText(path.join(DOCS, "RUNBOOK.md"));
    expect(runbook).toContain(readJson(E_BASELINE).baselineId);
    expect(runbook).toContain("NOT_REPRODUCIBLE");
    expect(runbook).toContain("不作活基线");
  });
});

describe("provenance manifest 不落凭据", () => {
  it.each([["e-baseline.json", E_BASELINE], ["phase2-pi-provenance.json", PHASE2_PI]])(
    "%s 无 key / secret / authorization 字面量",
    (_name, file) => {
      const text = readText(file as string);
      expect(text).not.toMatch(
        /"apiKey"|"api_key"|"secret"|"password"|"authorization"|sk-[A-Za-z0-9]{20,}/i,
      );
    },
  );
});
