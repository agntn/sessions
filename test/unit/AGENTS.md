# AGENTS.md

## Scope

Unit and fixture tests for native session adapters and public package contracts.

## Conventions

- Build native records in temporary directories and remove every resource in `afterEach`.
- Assert normalized observable behavior rather than private parser helpers.
- Keep fixtures small and test shared parser behavior only in the adapter that owns it.
- Run the focused test before the full Vitest suite.
