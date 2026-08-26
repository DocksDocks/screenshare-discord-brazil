import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    maxWorkers: 6,
    pool: "threads",
  },
});
