import { defineConfig } from "vitest/config";
import path from "path";
process.env.TZ = "UTC";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
