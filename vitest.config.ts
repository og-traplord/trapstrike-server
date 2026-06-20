import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@trapstrike/shared": resolve(dir, "packages/shared/src/index.ts"),
      "@trapstrike/protocol": resolve(dir, "packages/protocol/src/index.ts"),
    },
  },
});
