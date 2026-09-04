# Task 1 report — authenticated DSH Runtime RPC

## Status

Completed. The Main-process Runtime path now reads the tokenized `dsh web:` URL,
uses the token-exchange redirect as the readiness signal, and exposes that URL
in the ready snapshot. `DshSessionClient` keeps clean URLs on the legacy dot
transport while tokenized URLs exchange one cookie and use the current slash
transport with an RPC envelope whose payload is `{ args: ... }`.

## Commit

`fix: support authenticated dsh runtime rpc` (local commit; no push)

## Tests run

- `npx vitest run test/runtime/health-check.test.ts test/runtime/runtime-manager.test.ts test/channel-bridge/dsh-session.test.ts`
  - Passed: 3 files, 33 tests.
- `npm run typecheck`
  - Passed: `tsc --noEmit -p tsconfig.node.json`.
- `git diff --check`
  - Passed.

## TDD evidence

The initial focused run failed on all three new behaviors: 303 was treated as
unhealthy, Runtime startup kept the clean URL and timed out, and the client
treated the token-exchange 303 as an API error. A later focused red test caught
the incorrect direct `{ args }` body; the installed 0.1.2-rc.1 transport source
shows slash endpoints still require the client-request RPC envelope, with
`payload: { args: ... }`.

## Concerns / limits

- This task did not start a real Runtime or modify vendor, user data, or an
  installed app. Its transport facts are verified against the installed
  `@deepseek-ai/dsh` 0.1.2-rc.1 package and focused tests.
- A tokenized URL is intentionally held only in the in-memory Runtime snapshot;
  it is not separately persisted to disk.
- Existing custom `waitForHealthy` hooks still receive the clean URL for legacy
  fixtures. The production default waits for the Runtime's announced token URL.
