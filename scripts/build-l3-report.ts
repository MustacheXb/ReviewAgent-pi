/**
 * L3 三列报告生成入口（#45，eval-only）。
 *
 * 用法：
 *   pnpm l3-report -- --input <l3-input.json> --out docs/report/token-eval/<id>
 *
 * 输入是预聚合的三列 + environment + 签字信息（见 L3ReportInput）；本入口
 * 只做纯函数装配 + 落盘，不跑任何模型 / judge。
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildL3Report, renderL3ReportMarkdown, type L3ReportInput } from "../src/eval/l3/index.js";

function parseArgs(argv: readonly string[]): { input: string; out: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }
  const input = values.get("--input");
  const out = values.get("--out");
  if (input === undefined || out === undefined) {
    throw new Error("usage: l3-report --input <l3-input.json> --out <report-dir>");
  }
  return { input: path.resolve(input), out: path.resolve(out) };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const input = JSON.parse(readFileSync(options.input, "utf8")) as L3ReportInput;
  const report = buildL3Report(input);
  const markdown = renderL3ReportMarkdown(report);
  await mkdir(options.out, { recursive: true });
  await writeFile(
    path.join(options.out, "l3-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(options.out, "environment.json"),
    `${JSON.stringify(input.environment, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(options.out, "L3-REPORT.md"), `${markdown}\n`, "utf8");
  console.info(
    `[l3-report] claimsAllowed=${report.claimsAllowed} ` +
      `environment=${report.environment.complete ? "complete" : `missing ${report.environment.missing.length}`} ` +
      `output=${options.out}`,
  );
  return 0;
}

process.exit(await main(process.argv.slice(2)));
