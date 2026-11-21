# logging

Structured JSON-lines logging for the server (§20.4: nothing internal reaches clients, §25: no secrets in logs).

Public API (`index.ts`):
- `logger` — process-wide logger. `logger.child({ correlationId })` binds fields to every line.
- `createLogger({ bindings?, sink?, level? })` — custom logger (tests inject a `sink`).
- `serializeError(err)` — `{ name, message, stack }` for an `error` field. Stacks belong in logs only.

Invariants:
- One JSON object per line: `time`, `level`, `message`, plus bound/extra fields.
- All fields go through `redactSensitive` (`src/lib/redact.ts`): passwords, tokens, cookies and
  secrets are replaced by `[REDACTED]`, even when a whole object is logged by mistake.
- Level from `LOG_LEVEL` (`debug|info|warn|error|silent`); default `info`, `silent` under tests.
- warn/error go to stderr, the rest to stdout.
