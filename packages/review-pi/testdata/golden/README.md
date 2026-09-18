# 黄金基准（golden fixtures）

测量常量面的字节真源，提取自 DSH 线 t-series 审计记录（测量产物，而非源码转写）：

- 源审计：`runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/B/rep-1/audit/20260914T180846.922-B-VUL4J-1.json`
  （gitignored，本机 runs/ 目录；迁移自 DSH 兄弟仓 phase2 实测）
- 提取方式：requests[0].messages[0].content（system prompt）、messages[1]（Zone B）、
  messages[2]（MR 消息）、messages[3..5]（预取三层）、messages[6] 与后续阶段消息
  （Phase 1–6 指令）；均按 `content` 原文字节落文件，未做任何改写。

## 文件清单

| 文件 | 内容 | 案例相关性 |
| --- | --- | --- |
| `system-prompt.txt` | Zone A 系统提示（2317 字节，跨 MR 字节稳定） | 案例无关 |
| `phase-1.txt` … `phase-6.txt` | 六阶段指令消息（"Phase N of 6 - <名称>." 起头） | 案例无关 |
| `zone-b-vul4j-1.txt` | VUL4J-1 的 Zone B 全文（14754 字节） | 案例相关 |
| `mr-message-vul4j-1.txt` | VUL4J-1 的 MR 用户消息 | 案例相关 |
| `vul4j-1.diff` | VUL4J-1 的统一 diff（自 MR 消息 ```diff 围栏内字节提取；空上下文行为单空格） | 案例相关 |
| `prefetch-{1,2,3}-vul4j-1.txt` | VUL4J-1 预取三层（Symbol/Reference/CallChain） | 案例相关 |

## 纪律

- 这些文件是**测量常量**：pi 内核线复刻组装面必须与之字节一致（P1a 断言；
  P2 正式字节门在此之上建门，对照 DSH 审计真源）。
- 修改任何一份文件都需要显式变更记录（它们不是可自由调参的测试数据）。
- 案例无关文件（system-prompt、phase-N）用于一切组装测试；案例相关文件
  仅用于 VUL4J-1 全链对照，且依赖根仓 `data/` 的同源快照。
