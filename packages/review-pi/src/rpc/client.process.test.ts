import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { ReviewRpcClient } from "./client.js";

// #24 S3 client 行为验收：fake server（tmp .mjs 脚本，不经 dist——服务端行为
// 与真 bin 无关，只驱动 client 的超时/退出/停止语义）验收宿主客户端契约：
// - 单请求超时只拒该请求不杀进程；迟到响应忽略；
// - 进程意外退出 → reject 全部 pending，消息含退出码与 stderr 尾段；
// - stop() 升级链：EOF 超时 → POSIX 组 SIGTERM（被拦）→ SIGKILL / Windows
//   taskkill /T /F 树杀——stop 必须收敛不挂死（防孤儿 node 的本机教训）；
// - 生命周期守卫：未 start 发请求 / 二次 start 的人话错误。
//
// fake server 写临时 .mjs 而非 `node -e`：Windows CreateProcess 对含引号/
// 反斜杠的长参数转义有坑，文件形态跨平台零歧义（bin.process.test.ts 的
// 呈现投影引擎 fixture 同款手法）。

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

/** fake server 脚本落盘（standalone ESM，无依赖） */
function writeFakeServerScript(name: string, body: string): string {
  const scriptPath = path.join(makeTempDir("review-pi-rpc-fake-server-"), name);
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

/** LF-only 行读取 + 收集（fake server 侧与真服务端同款 framing 纪律） */
const LINE_READER_PREAMBLE = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    onLine(JSON.parse(line));
  }
});
process.stdin.resume();
`;

/** 超时面：第 1 行存住不回；第 2 行到达后两条响应一起回（第一条 = 迟到响应） */
const TIMEOUT_SCRIPT = `
const requests = [];
function onLine(request) {
  requests.push(request);
  if (requests.length === 2) {
    for (const pending of requests) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { pong: true, echoedMethod: pending.method } }) + "\\n");
    }
  }
}
${LINE_READER_PREAMBLE}
`;

/** 退出面：stderr 打标记，收到首行即 process.exit(7) */
const EXIT_SCRIPT = `
process.stderr.write("fake-server: deliberate crash marker\\n");
let done = false;
function onLine() {
  if (done) return;
  done = true;
  process.exit(7);
}
${LINE_READER_PREAMBLE}
`;

/** 停止面：拦 SIGTERM 不退 + setInterval 保活（EOF 也不退）——只有 SIGKILL / taskkill 能终结 */
const UNKILLABLE_SCRIPT = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 60000);
process.stdin.resume();
`;

/** 守卫面：stdin EOF 自然退（无保活句柄）——断言失败时 stop() 走 EOF 级即收敛，孤儿风险只剩升级链单条用例 */
const EOF_EXIT_SCRIPT = `
process.stdin.resume();
`;

test("生命周期守卫：未 start 发请求 → not started；二次 start → already started", async () => {
  const client = new ReviewRpcClient();
  expect(() => client.capabilities()).toThrow(/not started/);

  const scriptPath = writeFakeServerScript("guard.mjs", EOF_EXIT_SCRIPT);
  const started = new ReviewRpcClient({
    command: process.execPath,
    args: [scriptPath],
    stopEofTimeoutMs: 400,
    stopTermTimeoutMs: 400,
  });
  await started.start();
  await expect(started.start()).rejects.toThrow(/already started/);
  await started.stop();
  expect(started.getExitInfo()).toBeDefined();
}, 30_000);

test("单请求超时：只 reject 该请求不杀进程；迟到响应被忽略；后续请求照常", async () => {
  const scriptPath = writeFakeServerScript("timeout.mjs", TIMEOUT_SCRIPT);
  const client = new ReviewRpcClient({
    command: process.execPath,
    args: [scriptPath],
    requestTimeoutMs: 400,
  });
  await client.start();

  // 第一个请求：fake server 存住不回 → 超时 reject（消息点名方法与超时）
  const first = client.get("job-a");
  await expect(first).rejects.toThrow(/no response to review\.get/);

  // 进程还活着：第二个请求发出后 fake server 双回——第一条是迟到响应（无
  // pending，静默忽略），第二条让第二个请求正常落定
  const second = await client.get("job-b");
  expect(second).toEqual({ pong: true, echoedMethod: "review.get" });
  expect(client.getExitInfo()).toBeUndefined();

  // stop 收口（fake server EOF 自然退）；对已退进程再 stop 幂等
  await client.stop();
  await client.stop();
}, 30_000);

test("进程退出：reject 全部 pending，消息含退出码与 stderr 尾段", async () => {
  const scriptPath = writeFakeServerScript("exit.mjs", EXIT_SCRIPT);
  const client = new ReviewRpcClient({ command: process.execPath, args: [scriptPath] });
  await client.start();

  // 两个并发请求都活到 fake server 退出（同步段先注册 pending，写经队列）
  const first = client.capabilities();
  const second = client.list();
  await expect(first).rejects.toThrow(/exited \(code=7/);
  await expect(second).rejects.toThrow(/exited \(code=7/);
  await expect(second).rejects.toThrow(/deliberate crash marker/);
  // 事故后新请求 fail fast（不落回 pending 挂到超时）
  expect(() => client.capabilities()).toThrow(/exited \(code=7/);
}, 30_000);

test(
  "stop 升级链：EOF 超时 → SIGTERM（被拦）→ SIGKILL / taskkill 终结——stop 收敛不挂死",
  async () => {
    const scriptPath = writeFakeServerScript("unkillable.mjs", UNKILLABLE_SCRIPT);
    const client = new ReviewRpcClient({
      command: process.execPath,
      args: [scriptPath],
      stopEofTimeoutMs: 400,
      stopTermTimeoutMs: 400,
    });
    await client.start();

    // fake server 吞掉 EOF（setInterval 保活）与 SIGTERM——升级链必须走到
    // 终结级；Windows 无信号语义，EOF 超时后直接 taskkill /T /F 树杀
    await client.stop();
    expect(client.getExitInfo()).toBeDefined();
    if (process.platform !== "win32") {
      expect(client.getExitInfo()?.signal).toBe("SIGKILL");
    }
  },
  30_000,
);
