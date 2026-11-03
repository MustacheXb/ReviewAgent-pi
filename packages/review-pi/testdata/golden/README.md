# 黄金基准（golden fixtures）

测量常量面的字节真源，提取自 DSH 线 t-series 审计记录（测量产物，而非源码转写），
均按原文/`content` 字节落文件，未做任何改写。

#32 / ADR-0014 起 E 是唯一内核形态：A–D 研究装置（直驱六相位、预取管线、
全仓注入、P2 字节门 A/B 线族对照）已根除，其黄金件（`wire-req0` / `zone-b` /
`prefetch-*` / `expected-baseline` / `wire-a-*` / `reply-a-*` /
`fullrepo-content` / `tool-outputs`）随之退役。存留清单如下——全部服务于
E 生产内核的组装面/工具面字节锁定与离线脚本语料。

## 文件清单

| 文件 | 内容 | 案例相关性 | 消费方 |
| --- | --- | --- | --- |
| `system-prompt.txt` | Zone A 系统提示（2317 字节，跨 MR 字节稳定） | 案例无关 | `zonea/system-prompt.test.ts` |
| `phase-1.txt` … `phase-6.txt` | 六阶段指令消息（"Phase N of 6 - <名称>." 起头） | 案例无关 | `loop/phases.test.ts` |
| `mr-message-vul4j-1.txt` | VUL4J-1 的 MR 用户消息 | 案例相关 | `testing/vul4j1-script.ts` |
| `vul4j-1.diff` | VUL4J-1 的统一 diff（自 MR 消息 ```diff 围栏内字节提取；空上下文行为单空格） | 案例相关 | `testing/vul4j1-script.ts`、`run/mr-boundary-guard.test.ts` |
| `reply-{1..5}-vul4j-1.txt` | DSH 线六请求回复 1–5（六相位各一文本回复，零工具形态） | 案例相关 | `testing/vul4j1-script.ts`（离线脚本语料） |
| `review-tools-dsh.json` | DSH 线审计 tools 面真源（点分名 + 描述 + parameters schema） | 案例无关 | `tools/registry.test.ts` |
| `review-tools-wire-dsh.json` | DSH 线 wire 工具面真源（下划线名序） | 案例无关 | `tools/registry.test.ts` |

## 提取源

- B 线族遗存（`mr-message` / `vul4j-1.diff` / `reply-*`）：DSH 线
  `runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/B/rep-1` 审计（源审计 gitignored，
  本机 runs/ 目录；迁移自 DSH 兄弟仓 phase2 实测）。
- `system-prompt` / `phase-N`：同审计的 Zone A / 阶段指令消息。
- `review-tools-*`：DSH 线工具注册面的审计与 wire 投影。

## 纪律

- 这些文件是**测量常量**：生产内核的组装面（系统提示 / 阶段指令 / 工具
  注册）与离线脚本语料与之字节一致。
- 修改任何一份文件都需要显式变更记录（它们不是可自由调参的测试数据）。
- 案例无关文件（system-prompt、phase-N、review-tools-*）用于一切组装
  测试；案例相关文件仅用于 VUL4J-1 全链与边界护栏测试，且依赖根仓
  `data/` 的同源快照。
