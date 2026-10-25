import path from "node:path";
import { describe, expect, test } from "vitest";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { parseCliArgs, USAGE_TEXT } from "./args.js";

// CLI 参数解析契约（#7 P3b，进程内主缝的第一层）：`review-pi review` /
// `review-pi smoke` / `review-pi disposition` 三个子命令的 argv 用法面。
// 形态对齐 DSH 线 args.ts（union 结果、不抛异常——用户输入错误是预期
// 路径），pi 线差异：
// - 缺省 config = E（生产入口切流，ADR-0011：自主拉取 + Context Ledger；
//   2026-10-19 决策前曾为 B；DSH 线缺省 A）；
// - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
// - smoke = P1b 双探针（无工具调用探针——config B 零工具，检视链不需要）；
// - disposition（#15）= Finding 处置落库 + KPI：本地数据面，--decision
//   三值枚举在 parse 层校验，库缺省 <out>/review-pi-cli/dispositions.json。

test("空 argv 与未知子命令 → 用法错误（不抛异常）", () => {
  expect(parseCliArgs([])).toEqual({
    ok: false,
    message: "missing command (expected `review`, `smoke`, `rpc`, `server` or `disposition`)",
  });
  expect(parseCliArgs(["deploy"])).toEqual({
    ok: false,
    message: 'unknown command "deploy" (expected `review`, `smoke`, `rpc`, `server` or `disposition`)',
  });
});

test("review 最小 argv：必填旗标 + 全缺省（config E = 生产入口切流 ADR-0011 / out / model / issue）", () => {
  const parsed = parseCliArgs(["review", "--repo", "repo", "--mr", "case.diff"]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "repo",
      mr: "case.diff",
      caseId: "case",
      config: "E",
      issue: "",
      out: "reviewagent-output",
      model: REVIEW_MODEL_ID,
    },
  });
});

test("caseId 派生：--mr 文件名去扩展名（含路径与无扩展名形态）", () => {
  const withPath = parseCliArgs(["review", "--repo", "r", "--mr", "a/b/VUL4J-1.diff"]);
  expect(withPath.ok && withPath.command === "review" && withPath.args.caseId).toBe("VUL4J-1");
  const noExtension = parseCliArgs(["review", "--repo", "r", "--mr", "diffs/mr-7"]);
  expect(noExtension.ok && noExtension.command === "review" && noExtension.args.caseId).toBe("mr-7");
  const doubleDot = parseCliArgs(["review", "--repo", "r", "--mr", "x/case.old.diff"]);
  expect(doubleDot.ok && doubleDot.command === "review" && doubleDot.args.caseId).toBe("case.old");
});

test("--config：A-E 全矩阵合法；非法值 → 用法错误并列出合法集", () => {
  for (const configId of ["A", "B", "C", "D", "E"] as const) {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", configId]);
    expect(parsed.ok && parsed.command === "review" && parsed.args.config).toBe(configId);
  }
  const bad = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", "F"]);
  expect(bad).toEqual({
    ok: false,
    message: 'invalid --config "F": expected one of A, B, C, D, E',
  });
});

test("未知旗标 / 重复旗标 / 值缺席（含值吞旗标）→ 用法错误", () => {
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--language", "zh"])).toEqual({
    ok: false,
    message: 'unknown flag "--language"',
  });
  expect(parseCliArgs(["review", "--repo", "r", "--repo", "r2", "--mr", "m"])).toEqual({
    ok: false,
    message: "duplicate flag --repo",
  });
  expect(parseCliArgs(["review", "--repo"])).toEqual({
    ok: false,
    message: "flag --repo requires a value",
  });
  // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--issue", "--out", "x"])).toEqual({
    ok: false,
    message: "flag --issue requires a value",
  });
});

test("--model：缺省钉住的评审模型；自由 id 透传；空白 id 拒绝", () => {
  const free = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "custom-gateway-model"]);
  expect(free.ok && free.command === "review" && free.args.model).toBe("custom-gateway-model");
  const blank = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "  "]);
  expect(blank).toEqual({
    ok: false,
    message: 'invalid --model "  ": must be a non-empty model id (free ids accepted)',
  });
});

test("--repo 可省（缺省 process.cwd()，#27 统一 repoPath 缺省链）；--mr 必填", () => {
  const omitted = parseCliArgs(["review", "--mr", "m.diff"]);
  expect(omitted).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: process.cwd(),
      mr: "m.diff",
      caseId: "m",
      config: "E",
      issue: "",
      out: "reviewagent-output",
      model: REVIEW_MODEL_ID,
    },
  });
  expect(parseCliArgs(["review", "--repo", "r"])).toEqual({
    ok: false,
    message: "missing required flag --mr",
  });
});

test("smoke：窄旗标面（仅 --model）；review 专属旗标对 smoke 是未知旗标", () => {
  const smoke = parseCliArgs(["smoke"]);
  expect(smoke).toEqual({ ok: true, command: "smoke", args: { model: REVIEW_MODEL_ID } });
  const withModel = parseCliArgs(["smoke", "--model", "probe-model"]);
  expect(withModel).toEqual({ ok: true, command: "smoke", args: { model: "probe-model" } });
  expect(parseCliArgs(["smoke", "--repo", "r"])).toEqual({
    ok: false,
    message: 'unknown flag "--repo"',
  });
});

test("USAGE_TEXT：宣告两个子命令（stderr 错误路径同款文案，单一来源）", () => {
  expect(USAGE_TEXT).toContain("reviewagent review [--repo <path>] --mr");
  expect(USAGE_TEXT).toContain("reviewagent smoke");
});

describe("disposition 子命令（#15 处置落库 + KPI）", () => {
  const DEFAULT_STORE = path.join("reviewagent-output", "reviewagent-cli", "dispositions.json");

  test("记录面最小 argv：必填三旗标 + 库缺省派生（review-pi-output/review-pi-cli/dispositions.json）；note 缺席省键", () => {
    expect(
      parseCliArgs(["disposition", "--run", "r.json", "--finding", "F100", "--decision", "accept"]),
    ).toEqual({
      ok: true,
      command: "disposition",
      args: {
        mode: "record",
        args: { run: "r.json", finding: "F100", decision: "accept", store: DEFAULT_STORE },
      },
    });
  });

  test("三种处置决定合法（accept / reject / false-positive）；非法值 → 用法错误列三值", () => {
    for (const decision of ["accept", "reject", "false-positive"] as const) {
      const parsed = parseCliArgs([
        "disposition",
        "--run",
        "r.json",
        "--finding",
        "F100",
        "--decision",
        decision,
      ]);
      expect(
        parsed.ok &&
          parsed.command === "disposition" &&
          parsed.args.mode === "record" &&
          parsed.args.args.decision,
      ).toBe(decision);
    }
    expect(
      parseCliArgs(["disposition", "--run", "r.json", "--finding", "F100", "--decision", "maybe"]),
    ).toEqual({
      ok: false,
      message: 'invalid --decision "maybe": expected one of accept, reject, false-positive',
    });
  });

  test("--note 透传；--store 显式覆盖；--out 派生库路径（<out>/review-pi-cli/dispositions.json）", () => {
    const withNote = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "reject",
      "--note",
      "历史回归",
    ]);
    expect(
      withNote.ok && withNote.command === "disposition" && withNote.args.mode === "record" &&
        withNote.args.args.note,
    ).toBe("历史回归");
    const explicitStore = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "accept",
      "--store",
      "runs/exp1/dispositions.json",
    ]);
    expect(
      explicitStore.ok &&
        explicitStore.command === "disposition" &&
        explicitStore.args.mode === "record" &&
        explicitStore.args.args.store,
    ).toBe("runs/exp1/dispositions.json");
    const derived = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "accept",
      "--out",
      "custom-out",
    ]);
    expect(
      derived.ok &&
        derived.command === "disposition" &&
        derived.args.mode === "record" &&
        derived.args.args.store,
    ).toBe(path.join("custom-out", "reviewagent-cli", "dispositions.json"));
  });

  test("--store 与 --out 互斥（显式库文件 vs 派生根，二义性 fail fast）", () => {
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--store",
        "s.json",
        "--out",
        "o",
      ]),
    ).toEqual({
      ok: false,
      message:
        "flags --store and --out are mutually exclusive: pass --store <file> explicitly, or let the store derive from --out",
    });
  });

  test("缺必填旗标：--run / --finding / --decision", () => {
    expect(parseCliArgs(["disposition", "--finding", "F", "--decision", "accept"])).toEqual({
      ok: false,
      message: "missing required flag --run",
    });
    expect(parseCliArgs(["disposition", "--run", "r", "--decision", "accept"])).toEqual({
      ok: false,
      message: "missing required flag --finding",
    });
    expect(parseCliArgs(["disposition", "--run", "r", "--finding", "F"])).toEqual({
      ok: false,
      message: "missing required flag --decision",
    });
  });

  test("未知旗标 / 重复旗标 / 值缺席 / 空白值 → 用法错误", () => {
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--repo",
        "x",
      ]),
    ).toEqual({ ok: false, message: 'unknown flag "--repo"' });
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--run",
        "r2",
        "--finding",
        "F",
        "--decision",
        "accept",
      ]),
    ).toEqual({ ok: false, message: "duplicate flag --run" });
    expect(parseCliArgs(["disposition", "--run"])).toEqual({
      ok: false,
      message: "flag --run requires a value",
    });
    expect(parseCliArgs(["disposition", "--run", "", "--finding", "F", "--decision", "accept"])).toEqual(
      { ok: false, message: "flag --run requires a non-empty value" },
    );
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--note",
        "  ",
      ]),
    ).toEqual({ ok: false, message: "flag --note requires a non-empty value" });
  });

  test("KPI 面：--stats 裸用走缺省库；--store/--out 同规则派生", () => {
    expect(parseCliArgs(["disposition", "--stats"])).toEqual({
      ok: true,
      command: "disposition",
      args: { mode: "stats", args: { store: DEFAULT_STORE } },
    });
    const explicit = parseCliArgs(["disposition", "--stats", "--store", "s.json"]);
    expect(
      explicit.ok && explicit.command === "disposition" && explicit.args.mode === "stats" &&
        explicit.args.args.store,
    ).toBe("s.json");
    const derived = parseCliArgs(["disposition", "--stats", "--out", "o"]);
    expect(
      derived.ok && derived.command === "disposition" && derived.args.mode === "stats" &&
        derived.args.args.store,
    ).toBe(path.join("o", "reviewagent-cli", "dispositions.json"));
  });

  test("记录面旗标在 KPI 面是模式错误（错误点名可用集）；--stats 重复拒绝", () => {
    expect(parseCliArgs(["disposition", "--stats", "--finding", "F1"])).toEqual({
      ok: false,
      message: 'unknown flag "--finding" (with --stats, accepted flags: --store, --out)',
    });
    expect(parseCliArgs(["disposition", "--stats", "--stats"])).toEqual({
      ok: false,
      message: "duplicate flag --stats",
    });
  });

  test("USAGE_TEXT 宣告 disposition 两用法面（单一来源）", () => {
    expect(USAGE_TEXT).toContain("reviewagent disposition --run");
    expect(USAGE_TEXT).toContain("reviewagent disposition --stats");
    expect(USAGE_TEXT).toContain("accept|reject|false-positive");
  });
});

// ---- rpc 子命令（#24 S3，ADR-0012；#27 v2 起 ADR-0013：--cwd 换 --repo-root） ----

describe("rpc 子命令", () => {
  test("最小 argv：全旗标缺省（out=reviewagent-output、concurrency=1、cwd 省键）", () => {
    expect(parseCliArgs(["rpc"])).toEqual({
      ok: true,
      command: "rpc",
      args: { out: "reviewagent-output", concurrency: 1 },
    });
  });

  test("全旗标显式：out / cwd / concurrency 透传（cwd 缺席省键，omit to discover）", () => {
    const parsed = parseCliArgs([
      "rpc",
      "--out",
      "runs/rpc",
      "--cwd",
      "repos",
      "--concurrency",
      "4",
    ]);
    expect(parsed).toEqual({
      ok: true,
      command: "rpc",
      args: { out: "runs/rpc", cwd: "repos", concurrency: 4 },
    });
  });

  test("--concurrency 非正整数（0/负数/小数/非数字）→ 用法错误", () => {
    for (const bad of ["0", "-1", "1.5", "two", ""]) {
      expect(parseCliArgs(["rpc", "--concurrency", bad])).toEqual({
        ok: false,
        message: `invalid --concurrency ${JSON.stringify(bad)}: must be a positive integer`,
      });
    }
  });

  test("未知旗标（含 v1 已移除的 --repo-root）/ 重复旗标 / 值缺席 → 用法错误（旗标循环共用）", () => {
    expect(parseCliArgs(["rpc", "--repo", "r"])).toEqual({
      ok: false,
      message: 'unknown flag "--repo"',
    });
    // v1 --repo-root 已随 allowlist 一并移除（ADR-0013 决策 3）——不再是已知旗标
    expect(parseCliArgs(["rpc", "--repo-root", "r"])).toEqual({
      ok: false,
      message: 'unknown flag "--repo-root"',
    });
    expect(parseCliArgs(["rpc", "--out", "a", "--out", "b"])).toEqual({
      ok: false,
      message: "duplicate flag --out",
    });
    expect(parseCliArgs(["rpc", "--out"])).toEqual({
      ok: false,
      message: "flag --out requires a value",
    });
  });

  test("USAGE_TEXT 宣告 rpc 用法面（单一来源）", () => {
    expect(USAGE_TEXT).toContain("reviewagent rpc [--out <dir>] [--cwd <dir>] [--concurrency <n>]");
    expect(USAGE_TEXT).toContain("stdio JSONL 长驻模式");
  });
});

// ---- server 子命令（#28，ADR-0013：HTTP JSON-RPC 长驻 + Bearer 鉴权 + 幂等） ----

describe("server 子命令", () => {
  test("最小 argv（缺省 sqlite）：--data-dir 必填落位、out 缺省即 dataDir、host/port/executor/concurrency 缺省", () => {
    expect(parseCliArgs(["server", "--auth-token-file", "tokens.json", "--data-dir", "data"])).toEqual({
      ok: true,
      command: "server",
      args: {
        host: "127.0.0.1",
        port: 8787,
        out: "data",
        authTokenFile: "tokens.json",
        // #31：executor 缺省 worker；concurrency 缺省随 executor（worker 2）
        executor: "worker",
        concurrency: 2,
        store: "sqlite",
        dataDir: "data",
      },
    });
  });

  test("--store memory 逃生口：无 --data-dir 面、out 缺省维持 reviewagent-output", () => {
    expect(parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"])).toEqual({
      ok: true,
      command: "server",
      args: expect.objectContaining({ store: "memory", out: "reviewagent-output" }),
    });
    const memory = parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"]);
    expect(memory.ok && "dataDir" in memory.args).toBe(false);
  });

  test("缺 --auth-token-file → 用法错误（鉴权器无从构造；先于 store 面判定）", () => {
    expect(parseCliArgs(["server"])).toEqual({
      ok: false,
      message: "missing required flag --auth-token-file",
    });
  });

  test("HOST / PORT 环境变量覆盖缺省；显式旗标再优先（三级优先）", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "9000";
    try {
      expect(
        parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"]),
      ).toEqual({
        ok: true,
        command: "server",
        args: expect.objectContaining({ host: "0.0.0.0", port: 9000 }),
      });
      expect(
        parseCliArgs([
          "server",
          "--auth-token-file",
          "t.json",
          "--store",
          "memory",
          "--host",
          "10.0.0.1",
          "--port",
          "8080",
        ]),
      ).toEqual({
        ok: true,
        command: "server",
        args: expect.objectContaining({ host: "10.0.0.1", port: 8080 }),
      });
    } finally {
      delete process.env.HOST;
      delete process.env.PORT;
    }
  });

  test("PORT 环境变量坏值 / --port 坏值 → parse 层人话（不等 bind 期 EADDRNOTAVAIL）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory", "--port", "99999"]),
    ).toEqual({
      ok: false,
      message: 'invalid --port "99999": must be an integer between 1 and 65535',
    });
    process.env.PORT = "not-a-port";
    try {
      expect(
        parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"]),
      ).toEqual({
        ok: false,
        message: 'invalid PORT environment variable "not-a-port": must be an integer between 1 and 65535',
      });
    } finally {
      delete process.env.PORT;
    }
  });

  test("HOST 环境变量空白 → 用法错误（缺省链不静默穿过坏值）", () => {
    process.env.HOST = "   ";
    try {
      expect(
        parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"]),
      ).toEqual({
        ok: false,
        message: 'invalid HOST environment variable "   ": must be a non-empty address',
      });
    } finally {
      delete process.env.HOST;
    }
  });

  test("--concurrency 非正整数 / 未知旗标 → 用法错误（与 rpc 同口径）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory", "--concurrency", "0"]),
    ).toEqual({
      ok: false,
      message: 'invalid --concurrency "0": must be a positive integer',
    });
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory", "--tls"]),
    ).toEqual({
      ok: false,
      message: 'unknown flag "--tls"',
    });
  });

  // ---- #29：产物保留窗口旗标 ----

  test("--artifact-retention-days 正整数解析；缺席 = 缺席省键（30 缺省在装配层）", () => {
    expect(
      parseCliArgs([
        "server",
        "--auth-token-file",
        "t.json",
        "--store",
        "memory",
        "--artifact-retention-days",
        "7",
      ]),
    ).toEqual({
      ok: true,
      command: "server",
      args: expect.objectContaining({ artifactRetentionDays: 7 }),
    });
    const absent = parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory"]);
    expect(absent.ok && "artifactRetentionDays" in absent.args).toBe(false);
  });

  test("--artifact-retention-days 坏值 → parse 层人话（0 / 小数 / 非数字）", () => {
    for (const bad of ["0", "-1", "1.5", "week"]) {
      expect(
        parseCliArgs([
          "server",
          "--auth-token-file",
          "t.json",
          "--store",
          "memory",
          "--artifact-retention-days",
          bad,
        ]),
      ).toEqual({
        ok: false,
        message: `invalid --artifact-retention-days ${JSON.stringify(bad)}: must be a positive integer`,
      });
    }
  });

  // ---- #30 P3a：job 存储后端旗标 ----

  test("--store 坏值 → parse 层人话（值域 sqlite|memory）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--data-dir", "d", "--store", "redis"]),
    ).toEqual({
      ok: false,
      message: 'invalid --store "redis": expected "sqlite" or "memory"',
    });
  });

  test("sqlite（缺省后端）缺 --data-dir → 用法错误（报错给两条出路：给目录或显式选逃生口）", () => {
    expect(parseCliArgs(["server", "--auth-token-file", "t.json"])).toEqual({
      ok: false,
      message:
        "missing required flag --data-dir (sqlite is the default store; pass --data-dir <dir>, or --store memory to opt out of persistence)",
    });
    expect(parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "sqlite"])).toEqual({
      ok: false,
      message:
        "missing required flag --data-dir (sqlite is the default store; pass --data-dir <dir>, or --store memory to opt out of persistence)",
    });
  });

  test("--store memory + --data-dir → 互斥拒绝（不留二义配置）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--store", "memory", "--data-dir", "d"]),
    ).toEqual({
      ok: false,
      message:
        "flag --data-dir is not accepted with --store memory: remove --data-dir, or pass --store sqlite",
    });
  });

  test("--out 显式优先（sqlite 面不派生 dataDir）；--data-dir 落位 dataDir 键", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--data-dir", "data", "--out", "runs-here"]),
    ).toEqual({
      ok: true,
      command: "server",
      args: expect.objectContaining({ store: "sqlite", dataDir: "data", out: "runs-here" }),
    });
  });

  test("USAGE_TEXT 宣告 server 用法面（单一来源）", () => {
    expect(USAGE_TEXT).toContain(
      "reviewagent server --auth-token-file <file> [--data-dir <dir>] [--store sqlite|memory] [--executor worker|inprocess] [--host <addr>] [--port <n>] [--out <dir>] [--concurrency <n>] [--artifact-retention-days <n>]",
    );
    expect(USAGE_TEXT).toContain("HTTP JSON-RPC 长驻服务");
    expect(USAGE_TEXT).toContain("--data-dir");
    expect(USAGE_TEXT).toContain("--store    <backend>");
    expect(USAGE_TEXT).toContain("--executor  <mode>");
  });

  test("--executor 值校验：非 worker/inprocess → 人话错误（--store 同款口径）", () => {
    expect(parseCliArgs(["server", "--auth-token-file", "t.json", "--data-dir", "d", "--executor", "thread"])).toEqual({
      ok: false,
      message: 'invalid --executor "thread": expected "worker" or "inprocess"',
    });
  });

  test("--executor inprocess 逃生口：concurrency 缺省回落 1（不随 worker 池抬升）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--data-dir", "d", "--executor", "inprocess"]),
    ).toEqual({
      ok: true,
      command: "server",
      args: expect.objectContaining({ executor: "inprocess", concurrency: 1 }),
    });
  });

  test("--executor worker + 显式 --concurrency 恒优先（缺省抬升不覆盖显式值）", () => {
    expect(
      parseCliArgs(["server", "--auth-token-file", "t.json", "--data-dir", "d", "--executor", "worker", "--concurrency", "1"]),
    ).toEqual({
      ok: true,
      command: "server",
      args: expect.objectContaining({ executor: "worker", concurrency: 1 }),
    });
  });
});
