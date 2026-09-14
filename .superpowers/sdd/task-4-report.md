# Task 4 implementation report

Status: implemented; focused and P0 verification passed.

Commit: `63fed1d` (`fix: execute synchronous child workflows inline`). Only the four Task 4 implementation/test files were staged; this report remains unstaged.

Base: `fc6542a`.

## Scope and behavior

- `WorkflowRunService.executeSubWorkflow` owns live child lookup, revision validation, creation, and execution. Synchronous children are persisted as running and executed inline, without competing for the parent's single Worker slot. Asynchronous children retain durable queue creation and immediately return `{ runId }`.
- Main's former ten-minute polling callback now delegates to the service method. The options callback remains for explicit compensation workflow integrations; normal live nodes use the service directly.
- An inline child's AbortController follows its parent, including cancellation that arrives before the child's execution begins. Parent listeners are removed when that execution finishes.
- The same inline child resumes after its durable retry `availableAt`; it is not recreated. Retry waiting is abortable and cancels the queued child when the parent is cancelled.
- Service-local lineage tracks descendant workflow IDs and rejects direct or indirect recursion before creating a repeated child run. Child permissions and model selection continue to inherit from the parent.
- The released child execution method is unchanged. Approval/form yielding, reconciliation, and UI are not included.

## TDD evidence

Read `test-driven-development/SKILL.md` and `testing-anti-patterns.md` before changes.

First RED command:

`npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-worker-integration.test.ts`

After correcting test setup to use `WorkflowStore.update` and making missing-child assertions safe, the suite had 6 expected failures / 81 passes: a bounded reproduction of Main's old callback reported `child remained queued behind parent`, parent completion was `paused` rather than `completed`, default live-child execution was unavailable, cancellation never reached a child, and recursive-lineage assertions saw the missing-executor error.

First GREEN: 87 / 87 tests passed after moving execution into the service and adding cancellation / lineage.

Second RED, requested retry extension: 2 failures / 87 passes. The synchronous parent became `paused` after its child scheduled a retry, and cancellation during the retry deadline left the queued child uncancelled.

Second GREEN: 89 / 89 tests passed after waiting to the due time and re-executing the same inline child with abortable waiting.

## Final verification

- Focused run: 2 files, 89 tests passed.
- `npm run test:workflow:p0`: 15 files, 255 tests passed. Existing renderer `ReactDOMTestUtils.act` deprecation and act-environment warnings remain; no test failures.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Concerns / limits

- Lineage is held in service memory, not persisted in the shared run schema; lineage across process restarts is not claimed.
- The verified retry contract assumes the synchronous parent occupies the single Worker, as required by this task. The new public synchronous method is also used for compensation calls with no active parent; a Worker polling race during a delayed retry in that separate scenario has not been tested or ruled out.
- Approval/form yielding still ends synchronous waiting with a non-completed result. No continuation protocol was added.
- Ordinary live-node embeddings that supplied a custom `executeSubWorkflow` callback now execute stored workflow definitions; the callback only handles compensation. The prior mock-based node test was replaced with a real stored-child test.
- No `.superpowers` or `.workbuddy-ai` files are to be staged with the implementation commit.

## Review fixes (follow-up to `63fed1d`)

Addressed both Important findings and the Minor lineage cleanup finding.

RED: added four regressions and ran the focused command before changing production code. Result: 4 failures / 89 passes. The parentless synchronous caller had no Worker lease on either attempt (`[false, false]` instead of `[true, true]`); direct child cancellation did not end its parent's ten-second retry wait within the bounded assertion; failed child lineage remained; queued asynchronous child cancellation also left lineage behind.

GREEN changes:

- Parentless synchronous calls (including Main compensation) now enqueue and wake the Worker, then observe the child's settlement. They never execute retries alongside an idle Worker. The real-Worker regression verifies exactly two provider calls with `maxAttempts: 2`, and a persisted Worker lease on each call, while unrelated work wakes Worker polling during the retry window.
- Parent-owned inline execution remains inline. Its retry wait observes both persisted child settlement and the parent abort signal. Direct child cancellation ends the wait promptly, clears the delay timer/listener, and does not restart the cancelled record. `cancel()` publishes the persisted result to service observers.
- Failed/completed child execution and direct cancellation clear their lineage; asynchronous queued children retain lineage until execution or cancellation. De-duplicated enqueue results also discard the unused candidate's lineage.
- Released child execution remains unchanged. The earlier concern about unowned compensation retry racing the Worker is superseded by this fix and its regression.

Final verification after review fixes:

- Focused suites: 2 files, 93 / 93 tests passed.
- `npm run test:workflow:p0`: 15 files, 259 / 259 tests passed (same existing React act warnings).
- `npm run typecheck`: passed.
- `git diff --check`: passed.

Remaining boundaries: lineage is service-local; approval/form yielding has no continuation protocol. The settlement observer listens to service events; future direct-store reconciliation that changes terminal status must also notify service observers. No reconciliation code was changed here.

Follow-up commit: `1f8789c` (`fix: coordinate child workflow retry ownership and cancellation`). Only `workflow-run-service.ts` and `workflow-worker-integration.test.ts` were staged; report and other `.superpowers` / `.workbuddy-ai` changes remain unstaged.
