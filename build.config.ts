import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  // One bundle, four inputs: the entries share the chunk holding the source
  // adapters, so the CLI, the MCP server and the shared tool executors read the
  // same registry the package entrypoint exposes.
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/cli.ts", "./src/mcp.ts", "./src/tool-operations.ts"],
    },
  ],
});
