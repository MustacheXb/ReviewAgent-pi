import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";

// #7 P3b 进程级烟测：spawn 真 bin（bin/review-pi.js → spawn dist/cli/main.js），
// loopback stub 服务器在真 HTTP 传输层上回放 fake 适配器同款 wire——SSE 渲染
// 单源 sseBody（stub 与 fake 适配器逐字节同格式）。这是真适配器路径的唯一
// 离线覆盖：真 OpenAI SDK 序列化 + globalThis.fetch + 真套接字 + 真进程边界。
//
// 哨兵纪律（票面验收）：key 只允许出现在 Authorization 头（stub 侧断言已
// 收到 Bearer <sentinel>）；绝不出现在 stdout/stderr/审计/运行记录（进程
// 输出面与 --out 落盘面全量扫描）。.env.local 装载摘要只报键名（单测面
// 已锁），本档再证一层：显式环境变量胜过 .env.local（诱饵值不进传输层）。
//
// 退出码契约：成功（含诚实截断）0 / 其余 1；拒跑 1 + 人话提示。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const BIN_PATH = path.join(packageDir, "bin", "review-pi.js");

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-process-smoke-sentinel-7f31";
/** .env.local 诱饵（显式环境变量必须胜出——诱饵值连传输层都不该到） */
const DECOY_KEY = "sk-decoy-from-env-local";

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

// ---- 自愈构建：与 bin 同一真源判鲜（cli-runtime 腿表），陈旧即按腿重建 ----
// CI 有显式 dist 前置构建（见 .github/workflows/ci.yml），本钩子通常 no-op；
// 本地首次跑或源码新于产物时自愈，保证进程烟测永远对着新鲜产物。
beforeAll(async () => {
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  // 腿间有依赖序：vendored pi 四包（root 脚本按依赖序）→ review-llm → 本包
  const buildOrder = [
    "pnpm build:pi",
    "pnpm --filter review-llm build",
    "pnpm --filter review-pi build",
  ];
  for (const command of buildOrder) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawnSync(command, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      timeout: 480_000,
    });
    if (run.status !== 0) {
      throw new Error(
        `self-heal build failed (${command}, exit ${run.status}):\n${run.stdout ?? ""}${run.stderr ?? ""}`,
      );
    }
  }
}, 600_000);

// ---- loopback stub：真 HTTP 传输层上的 canned 网关 ----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body?: unknown;
}

interface LoopbackStub {
  /** 网关 base URL（自带 /v1——OpenAI SDK 只追加 /chat/completions） */
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
}

/**
 * 回环网关 stub：health GET /v1/models、模型探针 POST /v1/chat/completions
 * （stream:false → JSON completion 回显）、检视回合 POST /v1/chat/completions
 * （stream:true → 依序回放脚本回复的 SSE，sseBody 与 fake 适配器同渲染器）。
 * 脚本耗尽即 500（脚本错配是测试自身的 bug，要炸出来不能静默复用旧回复）。
 */
function startLoopbackStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
  const queue = [...replies];
  const requests: StubRequestRecord[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        ...(body !== undefined ? { body } : {}),
      });
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: REVIEW_MODEL_ID }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const wantsStream = (body as { stream?: unknown } | undefined)?.stream === true;
        if (!wantsStream) {
          // 模型探针（max_tokens:1 的非流式 ping）：回显模型 + 合法 usage
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              model: (body as { model?: unknown } | undefined)?.model ?? REVIEW_MODEL_ID,
              choices: [
                { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
          return;
        }
        const reply = queue.shift();
        if (reply === undefined) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "stub: scripted replies exhausted" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sseBody(reply));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
    });
  });
  return new Promise<LoopbackStub>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests: () => requests.map((record) => ({ ...record })),
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

// ---- 进程面辅助 ----

interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunBinOptions {
  /** 显式注入子进程的环境变量（覆盖本机残留；REVIEWER_* 必须显式给） */
  readonly env?: Record<string, string>;
  /** 预写进子进程 cwd 的 .env.local 内容（.env.local 语义面；不写则无该文件） */
  readonly seedEnvLocal?: string;
  readonly timeoutMs?: number;
}

/**
 * spawn 真 bin（cwd = 干净 tmpdir——不捡到仓库根的 .env.local，本机注入面
 * 确定性）。退出码/stdout/stderr 全捕获；超时即杀（status null）。
 *
 * 必须异步 spawn（不能 spawnSync）：stub 服务器活在本进程——spawnSync 会
 * 冻结事件循环，子进程的 HTTP 请求永远等不到 accept（子等响应、亲等退出，
 * 活锁成对超时）。异步 spawn 让事件循环在 await 间隙继续伺服 stub。
 */
function runBin(args: readonly string[], options: RunBinOptions = {}): Promise<CliRunResult> {
  const cwd = makeTempDir("review-pi-cli-cwd-");
  if (options.seedEnvLocal !== undefined) {
    writeFileSync(path.join(cwd, ".env.local"), options.seedEnvLocal, "utf8");
  }
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? 100_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      }
    });
  });
}

/** 递归收集目录下全部文件路径（落盘面哨兵扫描用） */
function collectFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** 哨兵泄漏断言：进程输出面 + --out 落盘面全量不含 key */
function expectNoKeyLeak(haystacks: readonly { label: string; text: string }[]): void {
  for (const { label, text } of haystacks) {
    expect(text.includes(SENTINEL_KEY), `${label} must not contain the API key`).toBe(false);
    expect(text.includes(DECOY_KEY), `${label} must not contain the .env.local decoy key`).toBe(false);
  }
}

/** 一轮零工具完成脚本：phase-5 出唯一候选 F100，phase-6 裁决通过 + complete */
function oneFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "sample.txt",
    line: 1,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: ["sample.txt:1"],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({ verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }], complete: true }),
      usage: ZERO,
    },
  ];
}

/** MAX_ROUNDS 截断脚本：5 轮 × 6 相位，phase-6 恒 complete:false */
function truncationCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const replies: FakeReply[] = [];
  for (let round = 0; round < 5; round++) {
    replies.push(
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: '{"candidates":[]}', usage: ZERO },
      { text: '{"verdicts":[],"complete":false}', usage: ZERO },
    );
  }
  return replies;
}

/** 子进程环境（哨兵网关显式注入；REVIEWER_* 优先序压过本机 DEEPSEEK_* 残留） */
function stubEnv(stubBaseUrl: string): Record<string, string> {
  return { REVIEWER_URL: stubBaseUrl, REVIEWER_API_KEY: SENTINEL_KEY };
}

// ---- 检视命令面 ----

test(
  "单 MR 检视（config B 缺省）：exit 0 + stdout 单 JSON + 候选存活成 finding + 落盘 + 凭据哨兵",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir],
        {
          env: stubEnv(stub.baseUrl),
          // .env.local 诱饵：显式环境变量必须胜出（诱饵 URL 是死端口，诱饵 key 不入传输层）
          seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        },
      );

      expect(run.status).toBe(0);
      // stdout 契约：单个 JSON 文档（尾随换行；多余字节即 JSON.parse 失败）
      const outcome = JSON.parse(run.stdout) as {
        ok: boolean;
        caseId: string;
        configId: string;
        runId: string;
        truncated: boolean;
        rounds: number;
        toolCalls: number;
        findings: { id: string; severity: string; title: string; file: string }[];
        auditPath: string;
      };
      expect(outcome).toMatchObject({
        ok: true,
        caseId: "VUL4J-1",
        configId: "B",
        truncated: false,
        rounds: 1,
        toolCalls: 0,
      });
      expect(outcome.runId).toMatch(/^\d{8}T\d{6}\.\d{3}-B-VUL4J-1$/);
      // 候选 → 裁决通过 → finding 存活（独立期望：字面量造的候选，非代码回算）
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "Sentinel finding title",
        file: "sample.txt",
      });
      // 审计与运行记录落盘（audit 文件名与 runId 同源）
      expect(existsSync(outcome.auditPath)).toBe(true);
      expect(path.basename(outcome.auditPath)).toBe(`${outcome.runId}.json`);
      expect(collectFiles(outDir).length).toBeGreaterThanOrEqual(2);

      // 传输层：恰好六回合（检视命令不发探针）；全部带哨兵 Authorization 头
      const requests = stub.requests();
      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }

      // 哨兵纪律：key 绝不进 stdout/stderr/落盘面
      const diskTexts = collectFiles(outDir).map((file) => ({
        label: path.basename(file),
        text: readFileSync(file, "utf8"),
      }));
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }, ...diskTexts]);
      // .env.local 装载摘要只报键名（值绝不回显）
      expect(run.stderr).toContain("skipped");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "截断路径：phase-6 恒 complete:false → exit 0 + truncated=true + rounds=5（诚实截断不是失败）",
  async () => {
    const stub = await startLoopbackStub(truncationCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir],
        { env: stubEnv(stub.baseUrl) },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        truncated: boolean;
        rounds: number;
        findings: unknown[];
      };
      expect(outcome.truncated).toBe(true);
      expect(outcome.rounds).toBe(5);
      expect(outcome.findings).toEqual([]);
      // 5 轮 × 6 相位 = 30 回合全走真 HTTP
      expect(stub.requests()).toHaveLength(30);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("陈旧产物拒跑：dist 回拨 30 天 → exit 1 + 人话提示 + stdout 干净（mtime 门）", async () => {
  const entry = path.join(packageDir, "dist", "cli", "main.js");
  const original = statSync(entry).mtime;
  const backdated = new Date(original.getTime() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(entry, backdated, backdated);
  try {
    const run = await runBin(["review", "--repo", repoFixturePath("sample"), "--mr", "x.diff"], {
      env: stubEnv("http://127.0.0.1:9/v1"),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("拒跑");
    expect(run.stderr).toContain("产物过期");
    expect(run.stderr).toContain("pnpm --filter review-pi build");
  } finally {
    utimesSync(entry, original, original);
  }
});

test("用法错误：缺 --mr → exit 1 + 人话错误 + usage 文案 + stdout 干净", async () => {
  const run = await runBin(["review", "--repo", repoFixturePath("sample")], {
    env: stubEnv("http://127.0.0.1:9/v1"),
    timeoutMs: 30_000,
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("review-pi:");
  expect(run.stderr).toContain("usage:");
});

test("运行失败：--repo 指向文件（非目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const notADir = path.join(makeTempDir("review-pi-cli-repo-"), "plain.txt");
  writeFileSync(notADir, "not a directory", "utf8");
  const run = await runBin(
    ["review", "--repo", notADir, "--mr", path.join(path.dirname(notADir), "x.diff")],
    { env: stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 30_000 },
  );
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("--repo is not a directory");
});

// ---- smoke 命令面 ----

test("smoke 子命令：双探针通过 → exit 0 + stdout 人话报告；哨兵只进 Authorization 头", async () => {
  const stub = await startLoopbackStub([]);
  try {
    const run = await runBin(["smoke"], { env: stubEnv(stub.baseUrl) });

    expect(run.status).toBe(0);
    // 人话报告（stdout）：OK 结论 + 双探针行
    expect(run.stdout).toContain(`smoke probes at ${stub.baseUrl} (model ${REVIEW_MODEL_ID}): OK`);
    expect(run.stdout).toContain("[1/2] gateway health:");
    expect(run.stdout).toContain("[2/2] model reachability:");
    // 双探针各一请求，均带哨兵 Authorization 头
    const requests = stub.requests();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    }
    expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
  } finally {
    await stub.close();
  }
});

test("smoke 子命令：网关不可达 → exit 1 + 人话诊断（健康探针失败，模型探针跳过）", async () => {
  // 死端口（无监听）：连接拒绝即失败，不依赖超时
  const run = await runBin(["smoke"], { env: stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 60_000 });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("FAILED");
  expect(run.stdout).toContain("gateway unreachable at http://127.0.0.1:9/v1");
  expect(run.stdout).toContain("skipped: the gateway is unreachable");
});
