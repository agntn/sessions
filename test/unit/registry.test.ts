import { describe, it, expect, beforeEach } from 'vitest'
import { register, createSource, sources, allSources, has } from '../../src/core/registry.ts'
import { UnknownSourceError } from '../../src/core/errors.ts'
import type { Source, Message } from '../../src/core/types.ts'

function makeStubSource(name: string): Source {
  return {
    name,
    available: () => true,
    async *ingest() {},
    cursor: () => '0',
  }
}

describe('registry', () => {
  it('registers and creates a source', () => {
    register('test-reg', () => makeStubSource('test-reg'))
    expect(has('test-reg')).toBe(true)

    const s = createSource('test-reg')
    expect(s.name).toBe('test-reg')
  })

  it('throws UnknownSourceError for missing source', () => {
    expect(() => createSource('nonexistent-xyz')).toThrow(UnknownSourceError)
  })

  it('lists registered sources', () => {
    register('test-list-a', () => makeStubSource('test-list-a'))
    register('test-list-b', () => makeStubSource('test-list-b'))
    const names = sources()
    expect(names).toContain('test-list-a')
    expect(names).toContain('test-list-b')
  })

  it('creates all sources', () => {
    const all = allSources()
    expect(all.length).toBeGreaterThan(0)
    for (const s of all) {
      expect(s.name).toBeTruthy()
    }
  })
})
