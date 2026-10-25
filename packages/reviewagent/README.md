# reviewagent

ReviewAgent 自包含 CLI、stdio 长驻与 HTTP server 包。

```bash
reviewagent review --repo <path> --mr <diff-file> [--config A-E]
reviewagent smoke [--model <id>]
reviewagent rpc --out <dir> [--repo-root <dir>] [--concurrency 1]
reviewagent server --auth-token-file <file> --host <host> --port <port> --data-dir <dir> [--executor worker|inprocess] [--concurrency 2]
```

本包在构建期将 vendored pi 运行时内联进 bundle（双入口：`dist/cli.mjs`
主入口 + `dist/review-worker.mjs` worker 线程体——server 形态缺省
worker 池执行，线程体由池按「cli.mjs 旁 review-worker.mjs」探测加载），
不再把 `@earendil-works/pi-*` 作为用户侧 npm 依赖发布或解析。
