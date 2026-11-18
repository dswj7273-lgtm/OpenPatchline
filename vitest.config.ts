import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/highlighter/highlight.worker.ts",
        // IPC 薄封装（invoke 透传）：由 Rust 集成测试覆盖契约，不计入前端覆盖率
        "src/api/**",
      ],
      thresholds: {
        // v0.8 验收门槛：前端覆盖率 ≥ 60%（docs/11 §五，按行计）。
        // 分支密度集中在大型视图组件的条件渲染，当前 ~50%；
        // 防回归下限设 45，后续组件测试补强时上调。
        lines: 60,
        functions: 55,
        statements: 60,
        branches: 45,
      },
    },
  },
});
