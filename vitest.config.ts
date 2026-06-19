import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    // 排除依赖、构建产物(.next/standalone 会把 e2e 拷进去)、Playwright e2e 目录
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/e2e/**"],
  },
});
