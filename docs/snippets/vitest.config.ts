import { defineConfig } from "vitest/config";
// Node by default; a snippet that draws DOM opts in with `// @vitest-environment happy-dom`.
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
