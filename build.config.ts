import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/types.ts',
        './src/embeddings.ts',
        './src/sources/index.ts',
        './src/cli.ts',
      ],
    },
  ],
  externals: [
    'better-sqlite3',
    '@huggingface/transformers',
  ],
})
