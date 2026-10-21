import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * #22 S1 jsonl：严格 LF-only JSONL 编解码（spec #21 §3、ADR-0012）。
 *
 * 机制单源移植自 pi `packages/coding-agent/src/modes/rpc/jsonl.ts`
 * （锚定 6671c604 与 checkout HEAD 间逐字节零变化——机制层稳定）。
 * 唯一行为差异：本仓 spec §3 规定**空行忽略**（pi 原样向回调发射空串）。
 *
 * 纪律：
 * - 分隔只认 `\n`；允许行尾单个 `\r`（CRLF 兼容）；
 * - U+2028/U+2029 写侧不转义（JSON.stringify 原样输出，与 pi 一致）——
 *   协议约束在读侧：客户端禁用通用行读取器（Node readline 会按 U+2028/
 *   U+2029 断行），必须用本 reader 的 LF-only 语义。
 */

/** 序列化一行 JSON 文档：恰好一个 JSON 值 + 单个 LF，不转义 U+2028/U+2029 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * 给流挂 LF-only 行读取器：只按 `\n` 分行、行尾单个 `\r` 剥离、
 * StringDecoder 正确处理跨块的多字节 UTF-8 分片、流 end 时冲出无换行尾行。
 * 返回解绑函数。
 */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  // CRLF 兼容：行尾单个 \r 剥离后交付；
  // 空行忽略（spec §3「一行恰好一个 JSON 文档；空行忽略」——与 pi 的差异点：
  // pi 原样向回调发射空串，由上层跳过；本仓在 framing 单源内收口）
  const emitLine = (line: string): void => {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (content.length > 0) {
      onLine(content);
    }
  };

  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  // 尾行无换行符也交付（EOF 冲刷）；StringDecoder 残留分片一并冲出
  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
