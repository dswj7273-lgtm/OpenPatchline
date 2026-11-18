/**
 * api/client 全量 mock 工厂（review 修复复用）：以真实模块的导出清单为
 * 底，把每个导出替换为 vi.fn（默认 async () => undefined），overrides
 * 覆盖需要的键。新增 IPC 命令时自动出现在 mock 里，无需逐个测试文件补。
 *
 * 用法（vi.mock 工厂会被提升到文件顶部，须用动态 import 引入本模块）：
 *   vi.mock("../api/client", async (importOriginal) => {
 *     const { createApiMock } = await import("./mockApi");
 *     return createApiMock(await importOriginal(), {
 *       getRepoInfo: async () => baseRepo,
 *     });
 *   });
 */
import { vi } from "vitest";

export function createApiMock<T extends object>(actual: T, overrides: Partial<T> = {}): T {
  const mock: Record<string, unknown> = {};
  const over = overrides as Record<string, unknown>;
  for (const key of Object.keys(actual)) {
    const provided = over[key];
    mock[key] =
      provided === undefined
        ? vi.fn(async () => undefined)
        : // 普通函数包一层 vi.fn：保留默认实现，同时可被
          // mockResolvedValue / toHaveBeenCalled 断言（vi.fn 原样透传）。
          vi.isMockFunction(provided)
          ? provided
          : vi.fn(provided as (...args: never[]) => unknown);
  }
  return mock as unknown as T;
}
