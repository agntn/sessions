import { describe, it, expect } from 'vitest'
import { builtinSources, aei, claude, mastra, opencode, codex, gemini, openclaw } from '../../src/sources/index.ts'

describe('source factories', () => {
  it('exports all built-in source factories', () => {
    expect(Object.keys(builtinSources)).toEqual(
      expect.arrayContaining(['aei', 'claude', 'mastra', 'opencode', 'codex', 'gemini', 'openclaw'])
    )
  })

  it('each factory returns a function that creates a source', () => {
    for (const [name, factory] of Object.entries(builtinSources)) {
      const createSource = factory()
      expect(typeof createSource).toBe('function')
      const source = createSource()
      expect(source.name).toBe(name)
      expect(typeof source.available).toBe('function')
      expect(typeof source.ingest).toBe('function')
      expect(typeof source.cursor).toBe('function')
    }
  })

  it('aei factory accepts custom db path', () => {
    const factory = aei('/tmp/custom.db')
    const source = factory()
    expect(source.name).toBe('aei')
    expect(source.available()).toBe(false) // path doesn't exist
  })

  it('claude factory accepts custom projects dir', () => {
    const factory = claude('/tmp/nonexistent-projects')
    const source = factory()
    expect(source.name).toBe('claude')
    expect(source.available()).toBe(false)
  })

  it('mastra factory accepts custom db path', () => {
    const factory = mastra('/tmp/nonexistent.db')
    const source = factory()
    expect(source.name).toBe('mastra')
    expect(source.available()).toBe(false)
  })

  it('codex factory accepts custom db path', () => {
    const factory = codex('/tmp/nonexistent.sqlite')
    const source = factory()
    expect(source.name).toBe('codex')
    expect(source.available()).toBe(false)
  })

  it('gemini factory accepts custom dir', () => {
    const factory = gemini('/tmp/nonexistent-gemini')
    const source = factory()
    expect(source.name).toBe('gemini')
    expect(source.available()).toBe(false)
  })

  it('openclaw factory accepts custom dirs', () => {
    const factory = openclaw(['/tmp/nonexistent-sessions'])
    const source = factory()
    expect(source.name).toBe('openclaw')
    expect(source.available()).toBe(false)
  })
})
