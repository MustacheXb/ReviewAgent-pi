# reviewagent

ReviewAgent 自包含 CLI 与 stdio 长驻包。

```bash
reviewagent review --repo <path> --mr <diff-file> [--config A-E]
reviewagent smoke [--model <id>]
reviewagent rpc --out <dir> [--repo-root <dir>] [--concurrency 1]
```

本包在构建期将 vendored pi 运行时内联进 bundle，不再把
`@earendil-works/pi-*` 作为用户侧 npm 依赖发布或解析。
