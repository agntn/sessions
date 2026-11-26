import { defineBuildConfig } from "obuild/config";

/** One bundle, so the CLI, MCP, the tool list and its executors share one source registry. */
export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cli.ts",
        "./src/ai.ts",
        "./src/mcp.ts",
        "./src/tools.ts",
        "./src/tool-operations.ts",
      ],
    },
  ],
});
