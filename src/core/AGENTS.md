# Core

Owns the normalized session contract and grouping of messages emitted by harness adapters.

- Keep the contract independent of databases and UI frameworks.
- A `SessionReader` exposes only `name`, `available()`, and `list()`.
- Preserve chronological message order and deterministic session order.
- Do not introduce ingest state, persistence, search, analytics, or watching.
