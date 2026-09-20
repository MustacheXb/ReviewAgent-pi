// P2 字节纪律门(#5)——共享 JSON 工具。
//
// wire-parity(比较器)与 ground-truth(真源加载)各自需要 JSON 值域深
// 相等(键序无关),原两处同形实现收口于此。

/** 深相等(JSON 值域,键序无关;JSON.parse 产物无 undefined/函数) */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => key in b && deepEqualJson(a[key], b[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
