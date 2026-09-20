import { expect, test } from "vitest";
import { isRipgrepTimeout, retryTransientSearch } from "./prefetch-retry.js";

// P2 字节纪律门(#5)——预取瞬态失败重试单测(门 harness 韧性,非产品代码)。
//
// 缝:纯函数 retryTransientSearch(attempt, backoffMs)——仅对 rg 超时特征
// 错误退避后整算一次;预取确定性保证重试产物与一次成功字节相同,不进
// 对照面噪声。实发两例:solo t2 探针、全量 t4 beforeAll(盘争用下单搜
// 30s 超时,Defender 实时扫描放大)。

test("瞬态判定:裸 rg 超时与上游包装错误均识别,其余不识别", () => {
  expect(isRipgrepTimeout(new Error("ripgrep timed out after 30000ms (pattern: foo)"))).toBe(true);
  expect(
    isRipgrepTimeout(
      new Error(
        'reference search failed for symbol "createClient": ripgrep timed out after 30000ms (pattern: createClient)',
      ),
    ),
  ).toBe(true);
  expect(isRipgrepTimeout(new Error('reference search failed for symbol "x": not found'))).toBe(false);
  expect(isRipgrepTimeout("ripgrep timed out")).toBe(false);
  expect(isRipgrepTimeout(undefined)).toBe(false);
});

test("首次成功:直返值,只调一次", async () => {
  let calls = 0;
  const value = await retryTransientSearch(
    () =>
      new Promise<string>((resolve) => {
        calls += 1;
        resolve("ok");
      }),
    0,
  );
  expect(value).toBe("ok");
  expect(calls).toBe(1);
});

test("瞬态失败:退避期满后重试一次,返回第二次产物", async () => {
  let calls = 0;
  const startedAt = Date.now();
  let secondCallAt = 0;
  const value = await retryTransientSearch(
    () =>
      new Promise<string>((resolve, reject) => {
        calls += 1;
        if (calls === 1) {
          reject(new Error("ripgrep timed out after 30000ms (pattern: p)"));
          return;
        }
        secondCallAt = Date.now();
        resolve("recovered");
      }),
    100,
  );
  expect(value).toBe("recovered");
  expect(calls).toBe(2);
  // 退避被尊重:第二次尝试不在退避期满前发起(下界断言,不抖动)
  expect(secondCallAt - startedAt).toBeGreaterThanOrEqual(95);
});

test("非瞬态错误:直通上抛,不重试", async () => {
  let calls = 0;
  await expect(
    retryTransientSearch(
      () =>
        new Promise<string>((_resolve, reject) => {
          calls += 1;
          reject(new Error('reference search failed for symbol "x": boom'));
        }),
      0,
    ),
  ).rejects.toThrow("boom");
  expect(calls).toBe(1);
});

test("重试仍瞬态:第二次错误如实上抛(恰好重试一次,不无限兜底)", async () => {
  let calls = 0;
  await expect(
    retryTransientSearch(
      () =>
        new Promise<string>((_resolve, reject) => {
          calls += 1;
          reject(new Error(`ripgrep timed out after 30000ms (pattern: p${calls})`));
        }),
      0,
    ),
  ).rejects.toThrow("p2");
  expect(calls).toBe(2);
});
