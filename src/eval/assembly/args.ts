/**
 * Campaign 进程入口的局部旗标抽取（#40）：`--judge-model` 不属于 campaign
 * plan（plan 只描述 campaign 身份），由装配层消费，因此在核心参数解析前
 * 从 argv 中摘除。
 */

export interface ExtractValueFlagResult {
  /** 摘除 flag 后的 argv（flag 及其值都已移除） */
  readonly argv: readonly string[];
  /** flag 值；未出现 = null */
  readonly value: string | null;
}

/**
 * 抽取单个单值 flag：支持 `--name value` 与 `--name=value`。
 * 重复给值 / 缺值 / 值与下一 flag 相邻（疑似漏值）一律报错——入口返回 2。
 */
export function extractValueFlag(
  argv: readonly string[],
  name: string,
): ExtractValueFlagResult {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === name) {
      if (value !== null) {
        throw new Error(`flag ${name} given more than once`);
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`flag ${name} requires a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (token.startsWith(`${name}=`)) {
      if (value !== null) {
        throw new Error(`flag ${name} given more than once`);
      }
      const inline = token.slice(name.length + 1);
      if (inline.trim() === "") {
        throw new Error(`flag ${name} requires a value`);
      }
      value = inline;
      continue;
    }
    rest.push(token);
  }
  if (value !== null && value.trim() === "") {
    throw new Error(`flag ${name} requires a non-empty value`);
  }
  return { argv: rest, value };
}
