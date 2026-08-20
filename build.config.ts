import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  // One bundle, two inputs: the entries share the chunk holding the source
  // adapters, so the shared tool executors read the same registry the package
  // entrypoint exposes.
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/tool-operations.ts"],
    },
  ],
});
