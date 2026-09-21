import { defineConfig } from "vitest/config";
// happy-dom, not jsdom: Lit 3 renders into a ShadowRoot and uses constructable stylesheets,
// which happy-dom supports natively.
export default defineConfig({ test: { environment: "happy-dom", include: ["src/**/*.test.ts"] } });
