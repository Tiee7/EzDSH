# Task 2 report: correct workflow health signals

## RED

Command:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
```

Result: 3 failures, 69 passing tests.

- Approval rejection persisted `approval-resolved`, not `approval-rejected`.
- `approval-rejected` observations were rejected as invalid because the event action was not serialized yet.
- A `run-failed` event two hours old returned `healthy`, demonstrating that elapsed time could clear the health signal.

## GREEN

Commands:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
npm run typecheck
```

Result:

- Focused tests: 2 files, 72 tests passed.
- Typecheck: `tsc --noEmit -p tsconfig.node.json` passed.
- `git diff --check` passed.

## Implementation and self-review

- Approval paths now emit `approval-approved` and `approval-rejected`; `approval-resolved` remains a supported legacy event.
- Rejected approvals map to a warning with failed outcome. Legacy resolved approvals map to unknown, so their historic ambiguity is not reinterpreted as a successful decision.
- Health retains existing no-observation, rollback, and recent-failure behavior. Beyond the recent-failure window, terminal `run-failed` observations remain degraded as `latest-run-failed` until `run-completed` is later for the same release group.
- Terminal signals are sorted by timestamp and event id before selecting each group's latest signal. Events without a release ID form a distinct legacy group; a successful run for another release cannot mask a failed group.
- No test-only production interfaces or mock-only assertions were added. The new tests exercise the real run and observation services.

## Compatibility

- Existing event type `approval-resolved` and health reasons remain accepted, preserving historical persisted records and serialized clients.
- The added `latest-run-failed` reason is additive. A recent failure still reports the existing `recent-failures` reason; once it ages out, a failed terminal signal stays degraded instead of becoming healthy by time alone.
- The Task 2 commit must include only the six brief-listed source/test files. This report and existing `.superpowers`/`.workbuddy-ai` workspace changes are intentionally excluded.

## Review follow-up: terminal-state recovery

### RED

Command:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
```

The first review regression run had one intended failure: old `approval-rejected` returned `healthy` rather than `degraded/latest-run-failed`. The same-release recovery case initially landed exactly at the exclusive 60-second window boundary and passed; after moving the failure inside the window, the confirmed RED run had two intended failures:

- a later `run-completed` for the same release still returned `degraded/recent-failures`;
- an old `approval-rejected` still returned `healthy`.

### GREEN

Commands:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
npm run typecheck
git diff --check
```

Result: focused tests passed (2 files, 74 tests); `tsc --noEmit -p tsconfig.node.json` and `git diff --check` passed.

### Fix and review

- Health now derives the latest terminal signal per release before checking recent failures. Errors in a release whose latest terminal signal is `run-completed` are resolved and cannot leave a stale recent failure warning.
- `approval-rejected` is a terminal failure signal for compatibility with observations already stored by the previous Task 2 commit. It remains explicit and, after the recent window, keeps the group degraded with the existing additive `latest-run-failed` reason.
- Rollback evaluation remains the first health decision. The approved execution path now directly asserts `approval-approved`.

Commit: `c11d9b9 fix: correct workflow health signals` (Task 2 files only; this report remains uncommitted).

## Review follow-up: newer errors after completion

### RED

Command:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
```

The new same-release scenario stored `run-completed` at `09:59:20` followed by `node-failed` at `09:59:30`. It failed as intended: health returned `healthy` instead of `degraded/recent-failures`, proving the prior completion incorrectly masked a later error.

### GREEN

Commands:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-observability-service.test.ts
npm run typecheck
git diff --check
```

Result: focused tests passed (2 files, 75 tests); `tsc --noEmit -p tsconfig.node.json` and `git diff --check` passed.

### Fix

The recent-error check now treats a same-release error as resolved only when that group's latest `run-completed` signal is strictly later under the existing timestamp/id ordering. Thus an older completion cannot mask a newer `node-failed` or `compensation-failed`, including equal-timestamp records with a deterministically later error id.

Commit: `c212c27 fix: correct workflow health signals` (Task 2 files only; this report remains uncommitted).
