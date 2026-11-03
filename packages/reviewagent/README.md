# reviewagent

ReviewAgent 自包含 CLI、stdio 长驻与 HTTP server 包（协议 v3——无配置选择，
请求面携带 `configId` 即 `-32019` 拒绝）。

```bash
reviewagent review [--repo <path>] --mr <diff-file> [--issue <text>] [--out <dir>] [--model <id>]
reviewagent smoke [--model <id>]
reviewagent rpc --out <dir> [--cwd <dir>] [--concurrency <n>]
reviewagent server --auth-token-file <file> --data-dir <dir> \
  [--store sqlite|memory] [--executor worker|inprocess] [--host <addr>] [--port <n>] \
  [--out <dir>] [--concurrency <n>] [--artifact-retention-days <n>]
reviewagent disposition --run <run-record.json> --finding <id> --decision accept|reject|false-positive [--note <text>] ([--store <file>] | [--out <dir>])
reviewagent disposition --stats ([--store <file>] | [--out <dir>])
```

`review` 无 `--config` 旗标（配置恒 E，服务端派生）；`--repo` 可省（缺省
process.cwd()）。完整协议与运维口径见源仓 README（MustacheXb/ReviewAgent-pi）。

本包在构建期将 vendored pi 运行时内联进 bundle（双入口：`dist/cli.mjs`
主入口 + `dist/review-worker.mjs` worker 线程体——server 形态缺省
worker 池执行，线程体由池按「cli.mjs 旁 review-worker.mjs」探测加载），
不再把 `@earendil-works/pi-*` 作为用户侧 npm 依赖发布或解析。
