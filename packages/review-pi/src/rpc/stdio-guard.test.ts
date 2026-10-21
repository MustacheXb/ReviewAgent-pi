/**
 * #22 S1 stdio-guard：stdout 接管 + raw 写队列 + backpressure（spec #21 §2/§9）。
 * 机制等价自 pi `packages/coding-agent/src/core/output-guard.ts`（锚定 6671c604，
 * 与 HEAD 逐字节零变化）。与 pi 的形态差异：pi 是模块级单例直接绑
 * process.stdout/stderr；本仓改为工厂 + 可注入 sink——单测无需劫持真实
 * process.stdout（vitest worker 的 reporter 依赖它），机制语义不变。
 */

import { expect, test } from "vitest";

import { createStdioGuard, type RawStdioSink } from "./stdio-guard.js";

/** 可记录写入内容的假 sink */
function fakeSink(): { sink: RawStdioSink; chunks: string[] } {
  const chunks: string[] = [];
  return {
    sink: {
      write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
        chunks.push(String(chunk));
        callback?.(null);
        return true;
      },
    },
    chunks,
  };
}

test("takeOverStdout：接管后 stdout 直写改道 stderr，restore 恢复原位", () => {
  const stdout = fakeSink();
  const stderr = fakeSink();
  const guard = createStdioGuard({ stdout: stdout.sink, stderr: stderr.sink });

  guard.takeOverStdout();
  expect(guard.isStdoutTakenOver()).toBe(true);
  // 任何绕过协议层的 stdout 直写（console.log / 第三方库）在接管面被改道 stderr
  stdout.sink.write("diagnostic\n");
  expect(stderr.chunks).toEqual(["diagnostic\n"]);
  expect(stdout.chunks).toEqual([]);

  guard.restoreStdout();
  expect(guard.isStdoutTakenOver()).toBe(false);
  stdout.sink.write("back-to-stdout\n");
  expect(stdout.chunks).toEqual(["back-to-stdout\n"]);
  expect(stderr.chunks).toEqual(["diagnostic\n"]);
});

test("takeOverStdout：三参 write(chunk, encoding, callback) 分发不丢回调（pi 判型分派）", () => {
  const stdout = fakeSink();
  const stderr = fakeSink();
  const guard = createStdioGuard({ stdout: stdout.sink, stderr: stderr.sink });
  guard.takeOverStdout();

  // 二参形态 write(chunk, callback)：回调转发
  let twoArgCallbackInvoked = false;
  stdout.sink.write("two-arg\n", () => {
    twoArgCallbackInvoked = true;
  });
  expect(twoArgCallbackInvoked).toBe(true);

  // 三参形态 write(chunk, encoding, callback)：encoding 不是函数——回调不得被吞
  // （丢回调 = 等待 flush 的调用方永久挂起；pi 用 encodingOrCallback 判型分派）
  let threeArgCallbackInvoked = false;
  const stdoutWrite = stdout.sink.write as unknown as (
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) => boolean;
  stdoutWrite("three-arg\n", "utf8", () => {
    threeArgCallbackInvoked = true;
  });
  expect(threeArgCallbackInvoked).toBe(true);

  // 两种形态都改道 stderr，stdout 协议流零混入
  expect(stderr.chunks).toEqual(["two-arg\n", "three-arg\n"]);
  expect(stdout.chunks).toEqual([]);
});

test("writeRawStdout：协议写走 raw 通道且保序；空串零写", async () => {
  const stdout = fakeSink();
  const guard = createStdioGuard({ stdout: stdout.sink });
  guard.takeOverStdout();
  guard.writeRawStdout('{"a":1}\n');
  guard.writeRawStdout('{"b":2}\n');
  guard.writeRawStdout("");
  await guard.waitForRawStdoutBackpressure();
  expect(stdout.chunks).toEqual(['{"a":1}\n', '{"b":2}\n']);
});

/** 按 attempt 序号编程失败的假 sink：数组元素为该次 write 的回调错误 */
function flakySink(errorsByAttempt: readonly (NodeJS.ErrnoException | null)[]) {
  const chunks: string[] = [];
  let attempt = 0;
  const sink: RawStdioSink = {
    write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
      chunks.push(String(chunk));
      callback?.(errorsByAttempt[attempt] ?? null);
      attempt += 1;
      return true;
    },
  };
  return { sink, chunks };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`write failed: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("writeRawStdout：ENOBUFS 非阻塞错误 → 重试至成功（字节最终落盘）", async () => {
  const stdout = flakySink([errnoError("ENOBUFS"), errnoError("EAGAIN"), null]);
  const guard = createStdioGuard({ stdout: stdout.sink, retryDelayMs: 1 });
  guard.takeOverStdout();
  guard.writeRawStdout('{"a":1}\n');
  await guard.flushRawStdout();
  expect(stdout.chunks).toEqual(['{"a":1}\n', '{"a":1}\n', '{"a":1}\n', ""]);
});

test("writeRawStdout：致命写错误 → onFatalError 收到错误（pi 为 exit 1）", async () => {
  const fatalErrors: unknown[] = [];
  const stdout = flakySink([errnoError("EBADF")]);
  const guard = createStdioGuard({
    stdout: stdout.sink,
    onFatalError: (error) => fatalErrors.push(error),
  });
  guard.takeOverStdout();
  guard.writeRawStdout('{"a":1}\n');
  await guard.waitForRawStdoutBackpressure();
  expect(fatalErrors).toHaveLength(1);
  expect((fatalErrors[0] as NodeJS.ErrnoException).code).toBe("EBADF");
});

test("flushRawStdout：排干尾链并补零字节写（退出前落盘保证）", async () => {
  const stdout = fakeSink();
  const guard = createStdioGuard({ stdout: stdout.sink });
  guard.takeOverStdout();
  guard.writeRawStdout('{"a":1}\n');
  await guard.flushRawStdout();
  expect(stdout.chunks).toEqual(['{"a":1}\n', ""]);
});

test("writeRawStdout/flush：未接管时 no-op（协议面只在接管后存在）", async () => {
  const stdout = fakeSink();
  const guard = createStdioGuard({ stdout: stdout.sink });
  guard.writeRawStdout('{"a":1}\n');
  await guard.flushRawStdout();
  expect(stdout.chunks).toEqual([]);
});
