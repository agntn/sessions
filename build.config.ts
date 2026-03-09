import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/types.ts", "./src/sources/index.ts", "./src/cli.ts"],
    },
  ],
});
