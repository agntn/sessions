import { pipeline, env, type Tensor } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const DIMENSIONS = 384

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipeline return type too complex for TS
let embedder: any = null
let cacheConfigured = false

function ensureCache() {
  if (!cacheConfigured) {
    env.cacheDir = process.env.HF_HOME || `${process.env.HOME}/.cache/huggingface`
    cacheConfigured = true
  }
}

async function getEmbedder() {
  ensureCache()
  if (!embedder) {
    embedder = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32',
    } as Record<string, unknown>)
  }
  return embedder
}

function tensorToF32(tensor: Tensor): Float32Array {
  const raw = tensor.data
  if (raw instanceof Float32Array) return raw
  return new Float32Array(raw as ArrayLike<number>)
}

export async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder()
  const output = await (model as Function)(text, { pooling: 'mean', normalize: true }) as Tensor
  return tensorToF32(output)
}

export async function embedBatch(texts: string[], batchSize = 32): Promise<Float32Array[]> {
  const model = await getEmbedder()
  const results: Float32Array[] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const outputs = await Promise.all(
      batch.map(t => (model as Function)(t, { pooling: 'mean', normalize: true }) as Promise<Tensor>)
    )
    for (const output of outputs) results.push(tensorToF32(output))
  }
  return results
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** Configure the HuggingFace cache directory. */
export function setCacheDir(dir: string): void {
  env.cacheDir = dir
  cacheConfigured = true
}

export { DIMENSIONS, MODEL_ID }
