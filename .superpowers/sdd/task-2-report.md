# Task 2 report — authenticated Runtime notifications and bundle verifier

## Status

Completed. Tokenized Runtime notification streams now exchange the launch URL
once, retain the returned `dsh-auth` cookie in memory per Runtime URL, and send
it to both WebSocket and SSE transports. The WebSocket factory's optional
headers argument preserves existing one-argument test factories.

The bundled verifier now waits for the Runtime's printed token URL, exchanges
it, probes the authenticated root, then exercises `workspace/create` and
`session/create` with `payload: { args: { request: ... } }`. It no longer calls
the removed `host.describe` endpoint or dot-style RPC endpoints.

## Commit

`fix: verify authenticated dsh runtime transport` (local commit; no push)

## Tests run

- `npx vitest run test/main/notifications.test.ts test/release/dsh-runtime-version.test.ts`
  - Passed: 2 files, 18 tests.
- `npm run check:published-dsh`
  - Passed: published `@deepseek-ai/dsh@0.1.2-rc.1` selected.
- `npm run typecheck`
  - Passed: `tsc --noEmit -p tsconfig.node.json`.
- `npm run build`
  - Passed: Electron/Vite main, preload, and renderer builds.
- `npm run test:workflow:p0`
  - Passed: 15 files, 208 tests. Existing React `act` warnings were emitted.
- `npm run verify:runtime`
  - Passed: bundled Runtime authenticated and created a workspace/session.
- `git diff --check`
  - Passed.

## TDD evidence

The initial focused run failed because no token exchange was performed for the
WebSocket downlinks and the verifier still used the legacy `host.describe`
probe. A second red test proved the SSE downlinks lacked the exchanged cookie.
After the first real verifier run, the Runtime returned its descriptor error;
the follow-up red fixture then locked the required generated-RPC argument shape
as `args.request` before the verifier was updated.

## Scope

No vendor source, user data, credentials, or installed app was changed.
