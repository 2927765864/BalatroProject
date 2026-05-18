import { defineConfig } from "vite";
import path from "node:path";

/**
 * Vite 配置
 * - base 设为 './'，方便部署到任意子路径（含 GitHub Pages）。
 * - 路径别名与 tsconfig.json 中的 paths 保持一致。
 */
export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@core": path.resolve(__dirname, "src/core"),
      "@tween": path.resolve(__dirname, "src/tween"),
      "@domain": path.resolve(__dirname, "src/domain"),
      "@render": path.resolve(__dirname, "src/render"),
      "@ui": path.resolve(__dirname, "src/ui"),
      "@fx": path.resolve(__dirname, "src/fx"),
      "@game": path.resolve(__dirname, "src/game"),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
