import type { Source, SourceFactory } from './types.ts'
import { UnknownSourceError } from './errors.ts'

const factories = new Map<string, SourceFactory>()

/** Register a source factory. */
export function register(name: string, factory: SourceFactory): void {
  factories.set(name, factory)
}

/** Create a source instance by name. */
export function createSource(name: string): Source {
  const factory = factories.get(name)
  if (!factory) {
    throw new UnknownSourceError(name)
  }
  return factory()
}

/** List all registered source names. */
export function sources(): string[] {
  return [...factories.keys()]
}

/** Create instances of all registered sources. */
export function allSources(): Source[] {
  return sources().map(createSource)
}

/** Check if a source is registered. */
export function has(name: string): boolean {
  return factories.has(name)
}
