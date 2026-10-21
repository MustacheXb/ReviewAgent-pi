/**
 * #22 S1 jsonl：严格 LF-only JSONL 编解码（spec #21 §3）。
 * 机制单源移植自 pi `modes/rpc/jsonl.ts`（锚定 6671c604，与 HEAD 逐字节零变化），
 * 唯一行为差异：本仓 spec §3 规定空行忽略（pi 会向回调发射空串）。
 */

import { Readable } from "node:stream";

import { expect, test } from "vitest";

import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

/** 手工推块的可控 Readable：精确控制分片边界（多字节切分/半行推送测试用） */
function controlledReadable(): Readable & {
  pushChunk(chunk: string | Buffer): void;
  endStream(): void;
} {
  const stream = new Readable({ read() {} });
  return Object.assign(stream, {
    pushChunk: (chunk: string | Buffer) => stream.push(chunk),
    endStream: () => stream.push(null),
  });
}

/** 等流 end（reader 的 onEnd 尾行 flush 先于本 promise 回调执行） */
function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => stream.on("end", resolve));
}

test("serializeJsonLine：对象 → 单行 JSON 文档 + LF 结尾", () => {
  expect(serializeJsonLine({ jsonrpc: "2.0", id: "1" })).toBe(
    '{"jsonrpc":"2.0","id":"1"}\n',
  );
});

test("U+2028/U+2029：serialize 不转义、不构成行边界——单行语义读写两侧成立", async () => {
  // spec §3 点名：JSON.stringify 不转义行/段分隔符（ES2019 JSON 超集接受它们），
  // JSONL 分行只认 LF——两者一起保证 U+2028/U+2029 是合法的单行内容。
  // 源码纪律：这两个码点是 JS 源码级行终止符，注释里写字面量会切断注释行——
  // 一律运行时构造（String.fromCharCode），源码全程可见可审查
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const payload = { issueDescription: `ab${LS}c${PS}d` };
  const line = serializeJsonLine(payload);
  // 序列化输出含原始码点（非 6 字符反斜杠转义序列），且全行仅结尾一个 LF
  expect(line).toBe(`{"issueDescription":"ab${LS}c${PS}d"}\n`);
  expect(line.includes("\\u2028")).toBe(false);
  expect(line.split("\n")).toHaveLength(2);

  // 读侧：含 U+2028/U+2029 的块按 LF 分行 → 仍是一行交付
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (received) => lines.push(received));
  const ended = streamEnded(stream);
  stream.pushChunk(line);
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual([`{"issueDescription":"ab${LS}c${PS}d"}`]);
});

test("attachJsonlLineReader：单块多行 → 逐行回调，行内容不含换行符", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  stream.pushChunk('{"a":1}\n{"b":2}\n');
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

test("attachJsonlLineReader：半行分块 → 跨块累积成完整行，不提前交付", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  stream.pushChunk('{"a"');
  stream.pushChunk(":1}\n");
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":1}']);
});

test("attachJsonlLineReader：多字节 UTF-8 跨块切分 → 字节级重组不产生替换符", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  // "漏洞" 的 UTF-8 字节序列被任意边界切开（Buffer.concat 后逐块推入）
  const full = Buffer.from('{"a":"漏洞"}\n', "utf8");
  const cuts = [0, 5, 8, 11, full.length];
  for (let i = 0; i < cuts.length - 1; i++) {
    stream.pushChunk(full.subarray(cuts[i]!, cuts[i + 1]!));
  }
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":"漏洞"}']);
});

test("attachJsonlLineReader：CRLF 输入 → 行尾单个 \\r 剥离后交付", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  stream.pushChunk('{"a":1}\r\n{"b":2}\r\n');
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

test("attachJsonlLineReader：EOF 无换行尾行 → end 时冲出交付", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  stream.pushChunk('{"a":1}\n{"b":2}');
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

test("attachJsonlLineReader：空行忽略（含剥 \\r 后为空）——spec §3 与 pi 的差异点", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  const ended = streamEnded(stream);
  stream.pushChunk('\n\n{"a":1}\n\r\n\n');
  stream.endStream();
  await ended;
  detach();
  expect(lines).toEqual(['{"a":1}']);
});

test("attachJsonlLineReader：detach 解绑 → 后续块与 end 不再触发回调", async () => {
  const lines: string[] = [];
  const stream = controlledReadable();
  const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
  stream.pushChunk('{"a":1}\n');
  // data 事件异步派发：先让事件循环转一拍，保证解绑前行已交付
  await new Promise((resolve) => setImmediate(resolve));
  detach();
  const ended = streamEnded(stream);
  stream.pushChunk('{"b":2}\n');
  stream.endStream();
  await ended;
  expect(lines).toEqual(['{"a":1}']);
});
