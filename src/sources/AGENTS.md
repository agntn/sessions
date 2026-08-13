# Harness adapters

Each file reads one harness's native session format and emits normalized messages through `read()`.

- Keep parsing local to the concrete harness adapter.
- `available()` checks whether the native source exists.
- `read()` reads the complete native archive without synchronization cursors.
- Preserve text, thinking, tool calls, tool results, roles, timestamps, session IDs, and useful native metadata.
- Bound individual untrusted payloads, but do not silently drop valid short messages.
- Add fixture coverage for every supported native format.
- Memory stores and conversation databases are not harness session sources.
