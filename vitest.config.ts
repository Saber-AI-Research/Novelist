import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reuse the root vite config (svelte plugin + `$lib` alias) so Vitest can
// resolve Svelte files and `$lib/...` imports the same way the app build does.
export default defineConfig(async (env) => {
  const resolvedViteConfig =
    typeof viteConfig === "function" ? await viteConfig(env) : viteConfig;

  return mergeConfig(resolvedViteConfig, {
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            include: ["tests/unit/**/*.test.ts"],
            environment: "happy-dom",
          },
        },
        {
          extends: true,
          test: {
            name: "integration",
            include: ["tests/integration/**/*.test.ts"],
            environment: "happy-dom",
          },
        },
      ],
      coverage: {
        provider: "v8",
        reporter: ["text", "html", "json"],
        // TS-only: all .svelte files are UI and covered by Playwright e2e, not
        // Vitest. Including them here would only drag the denominator down.
        // See tests/COVERAGE.md for the per-category waiver rationale.
        include: ["app/lib/**/*.ts"],
        exclude: [
          "app/lib/ipc/commands.ts",
          "app/lib/**/*.d.ts",
          "tests/**",
          "node_modules/**",
          // Campaign waivers (2026-04-22) — see tests/COVERAGE.md
          "app/lib/components/icons/index.ts",
          "app/lib/i18n/index.ts",
          "app/lib/i18n/types.ts",
          "app/lib/i18n/locales/en.ts",
          "app/lib/i18n/locales/zh-CN.ts",
          "app/lib/updater.ts",
          "app/lib/utils/benchmark.ts",
          "app/lib/utils/scroll-edit-test.ts",
          "app/lib/utils/resize-drag.ts",
          "app/lib/utils/window-drag.ts",
          "app/lib/utils/startup-timing.ts",
        ],
        // Thresholds deferred — P1 ships reports-only (see tests/COVERAGE-BASELINE.md).
        // Enforcement will land once baseline closes per-module gaps (P2+).
      },
    },
  });
});
