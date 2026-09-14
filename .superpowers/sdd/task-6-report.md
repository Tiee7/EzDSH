# Task 6 report: Workflow effect review controls

## Delivered

- Added an execution-review panel that derives reconciliation targets only from durable `effectState: 'unknown'` entries.
- Shows node identity, loop iteration identity when applicable, and the saved node or iteration input.
- Requires a trimmed 1 to 500 character review note. Both decisions remain disabled for empty or invalid notes.
- `not-dispatched` can proceed directly. `dispatched` requires a second explicit confirmation and states that no output is generated or backfilled.
- Calls `workflowRuns.reconcileEffect` with only the exact node, optional iteration ID, outcome, and trimmed note. On success the returned run record updates the current record and list. Busy, error, and confirmation-cancel states are represented in the UI.
- Added Chinese and English locale copy and minimal styles within the existing workflow stylesheet.

## TDD evidence

- RED: `npx vitest run test/renderer/workflow-page.test.tsx --reporter=dot` failed because the execution review did not contain `副作用人工核对`.
- GREEN: the same test passed after the UI implementation.

## Verification

- `npx vitest run test/renderer/workflow-page.test.tsx --reporter=dot` passed: 87 tests.
- `npm run test:workflow:p0` passed: 15 files, 286 tests.
- `npm run typecheck` passed.
- `git diff --check` passed.

## Known concern

The existing renderer suite emits pre-existing React `act` environment/deprecation warnings from Domino-based tests. The tests pass and this task does not alter that test harness.

## Review follow-up

- Target identity now includes the run ID, optional iteration ID, node ID, attempt, reconciliation-history length, and latest matching effect event. A new run or a later unknown occurrence cannot reuse a prior note or dispatched confirmation.
- Top-level loop-body summaries are excluded using the same `workflowLoopBodyNodeIds` rule used by the service. Only a durable nested iteration entry can produce a loop reconciliation target.
- An asynchronous reconciliation result always updates its run in the list, but it refreshes the detail panel only if that run is still selected when the bridge resolves.
- Textareas and every reconciliation action include an accessible label with node and loop-iteration identity.
- Reconciliation failures use locale-owned UI copy, including English, rather than exposing the backend error message.
- Follow-up RED tests covered occurrence keys, loop projections, deferred response selection, accessibility labels, and English error copy. GREEN verification: Renderer 92 tests; P0 291 tests; typecheck and diff check passed.

## Acceptance-test follow-up

- Added real `WorkflowPage` interaction coverage using the exposed preload bridge, not a panel callback alone.
- The successful path clicks the unknown loop-effect action and verifies the exact run ID, node ID, iteration ID, outcome, and trimmed note sent to `workflowRuns.reconcileEffect`; it also observes the returned record in both the detail surface and run-history row.
- The rejecting bridge path verifies English localized error copy while retaining the original note and dispatched-confirmation context.
- These production paths already passed once the renderer test's Domino and React Flow browser shims were in place. No production behavior changed to manufacture a RED result.
- Verification: Renderer 94 tests; P0 293 tests; typecheck and diff check passed.
