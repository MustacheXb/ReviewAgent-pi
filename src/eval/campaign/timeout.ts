/**
 * 单阶段有界等待（#40 冒烟事故修复）：真实网络 / 文件系统可能挂起，超时
 * 转成普通异常，由调用方按阶段留痕并继续。
 *
 * 语义边界：超时不取消底层 promise（Promise 无取消语义）；真实 HTTP 客户端
 * 自带 AbortSignal 超时与有界重试，文件写入为幂等覆盖，因此超时后不会造成
 * 不可恢复的状态。测试路径（fake）缺省不设超时或写入极快，行为稳定。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (timeoutMs === undefined) {
    return await promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`campaign: ${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
