import { fileURLToPath } from "node:url";

/** 合成仓库 fixture 的绝对路径（testdata/repos/<name>） */
export function repoFixturePath(name: string): string {
  return fileURLToPath(new URL(`../../testdata/repos/${name}`, import.meta.url));
}
