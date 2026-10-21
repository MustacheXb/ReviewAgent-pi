# t1–t5 门零漂移验证留痕（#23 stdio rpc S2）

## 验证目的

issue #23（stdio rpc S2：内核 signal/onProgress 缝 + runReview 真接线 + running cancel 实装）验收标准第一条：

> **t1–t5 字节门 + 语义门零漂移**：signal / onProgress 未配置时逐字节同基线

S2 在内核两处动了执行面（`review-loop.ts` / `agent-review-loop.ts` 增加 signal 边界检查与 onProgress 观测点；`pi-client.ts` 增加可选 signal 透传）。两缝均按缺席省键纪律实现——未配置时零对象构造、零介入。本门跑验证该纪律成立：**全部 t-series 门在含 S2 改动的工作区上原样通过，字节面与语义面零漂移。**

## 命令与环境

| 项 | 值 |
| --- | --- |
| 命令 | `pnpm --filter review-pi test:gate` |
| 日期 | 2026-10-21 |
| 基线 commit | `af762eb`（main）+ #23 工作区改动（未提交形态——验证对象即 S2 改动本身） |
| Node | v24.13.0 |
| vitest | 2.1.9 |
| 平台 | Windows 11 Pro（本机；CI 侧 ubuntu 门另由 CI 把口） |
| 总时长 | 5237s（约 87 分钟；t2 门独占 5230s——config B 预取重建为已知重项） |

## 结果总览

```
Test Files  14 passed (14)
     Tests  456 passed (456)
 exit code  0
```

## 分项结果

| 门文件 | 测试数 | 时长 | 说明 |
| --- | --- | --- | --- |
| byte-gate.t1.gate.ts | 30 | 359s | t1 A/B 字节门（逐字节） |
| byte-gate.t1.agent.gate.ts | 45 | 10s | t1 C/D/E 语义门 |
| byte-gate.t2.gate.ts | 36 | 5230s | t2 A/B 字节门（含预取重建） |
| byte-gate.t2.agent.gate.ts | 54 | 10s | t2 C/D/E 语义门 |
| byte-gate.t3.gate.ts | 36 | 127s | t3 A/B 字节门 |
| byte-gate.t3.agent.gate.ts | 54 | 10s | t3 C/D/E 语义门 |
| byte-gate.t4.gate.ts | 42 | 243s | t4 A/B 字节门 |
| byte-gate.t4.agent.gate.ts | 63 | 10s | t4 C/D/E 语义门 |
| byte-gate.t5.gate.ts | 36 | 70s | t5 A/B 字节门 |
| byte-gate.t5.agent.gate.ts | 54 | 10s | t5 C/D/E 语义门 |
| byte-gate-control.gate.ts | 3 | 0.5s | 门自检（truth 目录哨兵） |
| byte-gate-coverage.gate.ts | 1 | 0s | 覆盖哨兵 |
| byte-gate-agent-coverage.gate.ts | 1 | 0s | agent 门覆盖哨兵 |
| tool-outputs-vul4j-1.gate.ts | 1 | 3s | 工具输出快照门 |

## 结论

- **零漂移成立**：S2 两缝（`signal` / `onProgress`）未配置时，A/B 路径逐字节、C/D/E 路径 JSON 值等价全部与基线一致——缺席省键纪律（optional 只在 present 时 spread）在两缝上兑现。
- 单元侧配套证据：`src/run/review-run-seams.test.ts`（7 tests）中「onProgress + signal 未中止：纯观测——wire 逐字节同无缝基线 run」直接断言了观测纯度；本门跑在全部 t-series 上复核同一结论。
- 观测性缝不进序列化面：`signal` 不参与 provider 请求序列化（`ProviderRequestOptions.signal` 通道）；`onProgress` 为进程内回调，无 wire 足迹。
