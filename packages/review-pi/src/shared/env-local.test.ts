import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { formatEnvLocalSummary, loadEnvLocalFile } from "./env-local.js";

// .env.local 装载（#4 真跑冒烟）：包边界内的零依赖 dotenv 子集，语义镜像
// 根仓 src/shared/env-local.ts（评测 CLI 同款装载器）——vitest 不会自动读
// .env.local，e2e 需显式装载后才能经 REVIEWER_URL/REVIEWER_API_KEY 守卫。
//
// 密钥纪律：装载结果只含键名与行号；值绝不进结果对象之外（哨兵断言：
// 坏行留痕不含原文，摘要不含任何值）。

const tempDirs: string[] = [];

function envFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-env-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, ".env.local");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺失文件 → exists:false，no-op 不报错（.env.local 是可选注入面）", () => {
  const target: Record<string, string | undefined> = {};
  const result = loadEnvLocalFile(path.join(tmpdir(), "no-such-dir", ".env.local"), target);
  expect(result.exists).toBe(false);
  expect(result.loadedKeys).toEqual([]);
  expect(target).toEqual({});
});

test("KEY=VALUE 注入；首个 = 分割（值中 = 保留），两侧空白剥离", () => {
  const target: Record<string, string | undefined> = {};
  const result = loadEnvLocalFile(
    envFile("REVIEWER_URL=https://gw.example.com/v1\nREVIEWER_API_KEY=abc=def==\n"),
    target,
  );
  expect(result.loadedKeys).toEqual(["REVIEWER_URL", "REVIEWER_API_KEY"]);
  expect(target["REVIEWER_URL"]).toBe("https://gw.example.com/v1");
  expect(target["REVIEWER_API_KEY"]).toBe("abc=def==");
});

test("空行与 # 注释行跳过；行内 # 是值的一部分（不解析）", () => {
  const target: Record<string, string | undefined> = {};
  const result = loadEnvLocalFile(
    envFile("# REVIEWER_API_KEY=sk-secret\n\nREVIEWER_URL=https://gw/v1#fragment\n"),
    target,
  );
  expect(result.loadedKeys).toEqual(["REVIEWER_URL"]);
  expect(result.skippedKeys).toEqual([]);
  expect(target["REVIEWER_URL"]).toBe("https://gw/v1#fragment");
  expect("REVIEWER_API_KEY" in target).toBe(false);
});

test("成对引号剥离（单/双），不成对原样保留；BOM 与 CRLF 安全", () => {
  const target: Record<string, string | undefined> = {};
  const content = "﻿REVIEWER_URL=\"https://gw.example.com/v1\"\r\nREVIEWER_API_KEY='sk-quoted'\r\nNOTE=unclosed\"quote\r\n";
  const result = loadEnvLocalFile(envFile(content), target);
  expect(result.loadedKeys).toEqual(["REVIEWER_URL", "REVIEWER_API_KEY", "NOTE"]);
  expect(target["REVIEWER_URL"]).toBe("https://gw.example.com/v1");
  expect(target["REVIEWER_API_KEY"]).toBe("sk-quoted");
  expect(target["NOTE"]).toBe("unclosed\"quote");
});

test("目标 env 已有非空值优先不覆盖；空值文件行不注入（均入 skippedKeys）", () => {
  const target: Record<string, string | undefined> = { REVIEWER_URL: "https://already-set/v1" };
  const result = loadEnvLocalFile(
    envFile("REVIEWER_URL=https://file-loses/v1\nREVIEWER_API_KEY=\n"),
    target,
  );
  expect(result.loadedKeys).toEqual([]);
  expect(result.skippedKeys).toEqual(["REVIEWER_URL", "REVIEWER_API_KEY"]);
  expect(target["REVIEWER_URL"]).toBe("https://already-set/v1");
  expect("REVIEWER_API_KEY" in target).toBe(false);
});

test("坏行留痕只报行号，绝不回显原文（裸贴 key 场景）", () => {
  const target: Record<string, string | undefined> = {};
  const result = loadEnvLocalFile(
    envFile("REVIEWER_API_KEY sk-bare-pasted-secret\nKEY = spaced\n"),
    target,
  );
  expect(result.malformedLines).toEqual(["line 1", "line 2"]);
  expect(JSON.stringify(result)).not.toContain("sk-bare-pasted-secret");
  expect(target).toEqual({});
});

test("formatEnvLocalSummary：只含键名与行号，任何值绝不出现在摘要里", () => {
  const target: Record<string, string | undefined> = {};
  const result = loadEnvLocalFile(
    envFile("REVIEWER_URL=https://gw.example.com/v1\nREVIEWER_API_KEY=sk-summary-sentinel\nBROKEN LINE\n"),
    target,
  );
  const summary = formatEnvLocalSummary(result);
  expect(summary).toContain("injected REVIEWER_URL, REVIEWER_API_KEY");
  expect(summary).toContain("malformed line 3");
  expect(summary).not.toContain("sk-summary-sentinel");
  expect(summary).not.toContain("https://gw.example.com/v1");
});
