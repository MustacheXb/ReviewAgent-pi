import { expect, test } from "vitest";
import { resolveReviewerEndpoint } from "./reviewer-endpoint.js";

// 网关接入解析（#4）：REVIEWER_URL / REVIEWER_API_KEY（> 旧 DEEPSEEK_* 别名）。
// 常量单源 = review-llm（冻结仪器）：变量名与探测序不在本包复制。
// 期望值来自独立真源：review-llm 常量与 DSH 线 env.ts 的同名语义
// （trim、尾斜杠归一、协议校验、key 缺失不回显值）。
//
// 纪律：错误信息绝不包含 key 值（哨兵 key 断言）；baseUrl 是接入点
// 不是秘密，可出现在诊断里。

test("REVIEWER_URL 胜出：trim + 尾斜杠归一，不追加 /chat/completions（pi SDK 自行拼路径）", () => {
  const endpoint = resolveReviewerEndpoint({
    REVIEWER_URL: "  https://gw.example.com/v1/  ",
    REVIEWER_API_KEY: "sk-reviewer",
    DEEPSEEK_URL: "https://alias.example.com",
    DEEPSEEK_API_KEY: "sk-legacy",
  });
  expect(endpoint.baseUrl).toBe("https://gw.example.com/v1");
  expect(endpoint.apiKey).toBe("sk-reviewer");
});

test("推荐名空值回退旧别名（DEEPSEEK_URL / DEEPSEEK_API_KEY）", () => {
  const endpoint = resolveReviewerEndpoint({
    REVIEWER_URL: "   ",
    DEEPSEEK_URL: "https://alias.example.com/v1",
    REVIEWER_API_KEY: "",
    DEEPSEEK_API_KEY: "sk-legacy",
  });
  expect(endpoint.baseUrl).toBe("https://alias.example.com/v1");
  expect(endpoint.apiKey).toBe("sk-legacy");
});

test("双名皆缺 → 官方缺省接入点 + 缺省不破坏路径形态", () => {
  const endpoint = resolveReviewerEndpoint({ REVIEWER_API_KEY: "sk-reviewer" });
  expect(endpoint.baseUrl).toBe("https://api.deepseek.com");
});

test("baseUrl 协议非法 → fail fast，错误含来源与原值", () => {
  expect(() =>
    resolveReviewerEndpoint({ REVIEWER_URL: "ftp://gw.example.com", REVIEWER_API_KEY: "sk" }),
  ).toThrow(/REVIEWER_URL.*ftp:\/\/gw\.example\.com|ftp:\/\/gw\.example\.com.*REVIEWER_URL/);
});

test("key 缺失 → fail fast：错误点名变量名，绝不回显 key 值", () => {
  let message = "";
  try {
    resolveReviewerEndpoint({ REVIEWER_URL: "https://gw.example.com/v1" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("REVIEWER_API_KEY");
  expect(message).toContain("DEEPSEEK_API_KEY");
  expect(message).not.toContain("sk-");
});
