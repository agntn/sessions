import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

/** Lint, format and test run on Vite+. The build stays on obuild (`build.config.ts`). */
export default defineConfig({
  fmt: { ...oxfmt, ignorePatterns: [] },
  lint: { ...oxlint, rules: { ...oxlint.rules }, ignorePatterns: [] },
  test: {
    globals: true,
    reporters: "dot",
    projects: [{ test: { name: "unit", include: ["test/unit/**/*.test.ts"], globals: true } }],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/**/*.test.ts"],
    },
  },
});
