import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import type { ToolCallRecord } from "../../src/instrument/contracts/run.js";
import {
  projectReviewDocument,
  type ProjectionDeps,
  type ReviewPresentationSource,
} from "../../src/presentation/translate-projection.js";
import { TERMINOLOGY_VERSION } from "../../src/presentation/terminology.js";

/**
 * #13 翻译投影对真实 E 产物的闭环（code-review Spec 项：「验收样例以
 * E 运行为准」不能只靠合成夹具自证）：消费 phase2-pi 真跑落盘的生产
 * 入口 E run record（2026-10-19 决策评论），锁两件事——
 * 1. zh 投影：真 E 的 findings / toolCallLog 过投影后，结构化字段
 *    （id/severity/category/file/line/evidence/rule/confidence、name/
 *    argumentsJson）逐字节直通，自然语言字段（title/description/
 *    resultSummary）恰各入引擎一次；
 * 2. en 呈现档 = 恒等直通（同一引用、零引擎调用）。
 *
 * 门控形态同仓先例（「本地快照存在时」）：runs/ 为 gitignored 本地
 * 产物，CI / 别机无此文件时整档跳过；真引擎（LLM）不在测试面，此处
 * 用确定性 fake 引擎锁调用面与直通面，翻译质量是消费端裁量事项。
 */

const REAL_E_RECORD = path.resolve(
  import.meta.dirname,
  "../../runs/phase2-pi/runs/vul4j/VUL4J-38/E/rep-1.json",
);

/** 真实 E 记录的呈现面投影源（findings + audit.toolCallLog 直通引用） */
function realPresentationSource(): ReviewPresentationSource {
  const raw = JSON.parse(readFileSync(REAL_E_RECORD, "utf8")) as {
    readonly baseline: {
      readonly findings: readonly Finding[];
      readonly audit: { readonly toolCallLog: readonly ToolCallRecord[] };
    };
  };
  return { findings: raw.baseline.findings, toolCallLog: raw.baseline.audit.toolCallLog };
}

describe("翻译投影 × 真实 E 产物（本地快照存在时）", () => {
  test.skipIf(!existsSync(REAL_E_RECORD))(
    "zh 投影：结构化字段逐字节直通、自然语言字段恰各入引擎一次、留痕齐全",
    async () => {
      const source = realPresentationSource();
      expect(source.findings.length).toBeGreaterThan(0);
      expect(source.toolCallLog.length).toBeGreaterThan(0);

      const calls: string[] = [];
      const deps: ProjectionDeps = {
        engine: async (text) => {
          calls.push(text);
          return `[zh]${text}`;
        },
      };
      const projected = await projectReviewDocument(deps, { source, language: "zh" });

      // findings：结构化字段 === 直通；自然语言字段 = 引擎输出
      expect(projected.findings).toHaveLength(source.findings.length);
      source.findings.forEach((sourceFinding, index) => {
        const projectedFinding = projected.findings[index] as Finding;
        expect(projectedFinding.id).toBe(sourceFinding.id);
        expect(projectedFinding.severity).toBe(sourceFinding.severity);
        expect(projectedFinding.category).toBe(sourceFinding.category);
        expect(projectedFinding.file).toBe(sourceFinding.file);
        expect(projectedFinding.line).toBe(sourceFinding.line);
        expect(projectedFinding.evidence).toBe(sourceFinding.evidence);
        expect(projectedFinding.rule).toBe(sourceFinding.rule);
        expect(projectedFinding.confidence).toBe(sourceFinding.confidence);
        expect(projectedFinding.title).toBe(`[zh]${sourceFinding.title}`);
        expect(projectedFinding.description).toBe(`[zh]${sourceFinding.description}`);
      });

      // toolCallLog：name / argumentsJson 直通；resultSummary = 引擎输出
      expect(projected.toolCallLog).toHaveLength(source.toolCallLog.length);
      source.toolCallLog.forEach((sourceCall, index) => {
        const projectedCall = projected.toolCallLog[index] as ToolCallRecord;
        expect(projectedCall.name).toBe(sourceCall.name);
        expect(projectedCall.argumentsJson).toBe(sourceCall.argumentsJson);
        expect(projectedCall.resultSummary).toBe(`[zh]${sourceCall.resultSummary}`);
      });

      // 留痕：呈现语言 + 术语表版本 + 源 finding 关联一一对应
      expect(projected.provenance.language).toBe("zh");
      expect(projected.provenance.terminologyVersion).toBe(TERMINOLOGY_VERSION);
      expect(projected.provenance.findingLinks).toEqual(
        source.findings.map((finding, index) => ({
          sourceFindingId: finding.id,
          projectedFindingId: projected.findings[index]?.id,
        })),
      );

      // 引擎恰对每个非空自然语言字段调用一次（真 E 记录全非空 → 2/finding + 1/工具调用）
      const expectedCalls =
        source.findings.reduce(
          (count, finding) =>
            count + (finding.title.length > 0 ? 1 : 0) + (finding.description.length > 0 ? 1 : 0),
          0,
        ) +
        source.toolCallLog.filter((call) => call.resultSummary.length > 0).length;
      expect(calls).toHaveLength(expectedCalls);
    },
  );

  test.skipIf(!existsSync(REAL_E_RECORD))("en 呈现档 = 恒等直通：同一引用、零引擎调用", async () => {
    const source = realPresentationSource();
    let engineCalls = 0;
    const deps: ProjectionDeps = {
      engine: async () => {
        engineCalls += 1;
        return "must-not-be-called";
      },
    };
    const projected = await projectReviewDocument(deps, { source, language: "en" });
    expect(projected.findings).toBe(source.findings);
    projected.findings.forEach((finding, index) => {
      expect(finding).toBe(source.findings[index]);
    });
    projected.toolCallLog.forEach((call, index) => {
      expect(call).toBe(source.toolCallLog[index]);
    });
    expect(engineCalls).toBe(0);
    expect(projected.provenance.language).toBe("en");
  });
});
