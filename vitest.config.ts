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
        include: ["app/lib/**/*.{ts,svelte}"],
        exclude: [
          "app/lib/ipc/commands.ts",
          "app/lib/**/*.d.ts",
          "tests/**",
          "node_modules/**",
        ],
        // Thresholds deferred — P1 ships reports-only (see tests/COVERAGE-BASELINE.md).
        // Enforcement will land once baseline closes per-module gaps (P2+).
      },
    },
  });
});
