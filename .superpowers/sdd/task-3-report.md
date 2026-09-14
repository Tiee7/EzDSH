# Task 3 — Structural loop recovery safety

Status: complete. Commit: `4c20f19` (`fix: make workflow loops recovery safe`).

## Scope

Changed only the five files assigned in task-3-brief.md: shared Workflow types, run store, run service, and the two specified test files. No UI changes, loop concurrency, approval/form execution support, or Task 1/2 feature changes. Read the full test-driven-development skill and its testing-anti-patterns reference before implementation.

## RED evidence

Initial command: `npx vitest run test/workflow/workflow-safe-execution.test.ts test/workflow/workflow-run-service.test.ts`.

Observed 9 failed / 82 passed (91 total), before production edits:

1. Different managed writes for A/B both received `${runId}:body`, instead of separate iteration 0/1 keys.
2. A successful first item followed by a transient second-item write produced `failed`, despite the body declaring an idempotent retry policy. The body bypassed the ordinary retry pipeline.
3. A lost write response produced `failed` instead of `paused`; the owning loop handled the exception without respecting the nested effect journal.
4. Reloading a persisted completed iteration returned recomputed `A!` instead of persisted `saved-A`, proving completed work was replayed.
5. Two successful compensated writes produced no compensation stack, because body completion bypassed registration.
6–9. Nested prepared, dispatched, incomplete confirmed, and unknown effects all recovered as `queued` instead of `paused`. Recovery inspected only top-level node states.

After initial GREEN (91/91), two compatibility failures were added and observed before their fixes (2 failed / 91 passed):

10. A legacy partial loop with an already confirmed/completed body write but no iteration history allowed resume. There is insufficient evidence to infer which prior iterations completed, so replay is unsafe.
11. A persisted iteration containing `nodeStates: null` was loaded as valid. Recursive recovery would traverse invalid data.

Self-review found another concrete failure and reproduced it before fixing it:

12. `failureStrategy: continue` with a failed GET followed by a successful GET stayed `failed`, not `completed` (focused run: 1 failed / 73 skipped). Saving the body failure as a terminal run released its lease before the loop continued, causing subsequent snapshots to be rejected as stale. A safe continuing failure now retains the running record/lease.

An existing linear-chain test also detected an intermediate implementation regression: the current-iteration top-level inspection projection did not show the second iteration's running first node and pending successor. Fixed the projection while keeping effects exclusively in nested durable states; existing test passed unchanged.

## Implementation

- Optional `loopIterations` lives on the owner node state. Each checkpoint stores zero-based index, stable iteration ID, original item, state, per-body-node states, and completed iteration output.
- Execution scope `{ loopNodeId, iterationIndex, iterationId }` accompanies nested states, node/effect/retry events, and compensation entries.
- Managed write keys inside loops are `${runId}:loop:${loopNodeId}:iteration:${iterationIndex}:node:${bodyNodeId}`. Non-loop keys stay `${runId}:${nodeId}`. GET behavior is unchanged.
- Structural body nodes now use `executeReadyNode` and `executeNodeWithRetry`, so attempts, delay/requeue, output diagnostics, effect phases, cancellation, and compensation share the ordinary pipeline.
- Before body execution, the owner is marked resumable in the same snapshot that may later queue/pause the body. A stopped body outcome bypasses the owner's retry policy, preventing a parent loop retry from replaying an ambiguous child effect.
- Each body input and identity are persisted before dispatch; effect phases and final output/compensation registration are persisted through the existing pipeline. Iteration completion is separately checkpointed, allowing recovery even if a body completed but the loop had not yet collected its result.
- Completed iterations reuse stored outputs. An incomplete iteration reuses completed body outputs and only executes unfinished nodes. Loop execution remains sequential and capped.
- Recovery and lost-lease release recursively inspect/reset nested states. Confirmed effects with incomplete body output remain unsafe and pause. Ordinary confirmed/completed body states survive recovery.
- Resume rejects nested uncertain effects. Unsupported loop approval/wait-input nodes fail without entering an approval wait state.
- Existing top-level body states remain a current-iteration projection for existing consumers. Their effect field is omitted because nested journal entries are authoritative; this prevents stale summary fields from reclassifying already completed effects as uncertain on the next iteration.
- Compensation deduplicates by source node and iteration identity, runs in reverse stack order, and resolves each compensation's input against its own iteration output.
- Safe `continue` failures retain the lease and produce one error result for the failed iteration. Ambiguous effects, cancellation, scheduled retry and invalid output diagnostics still stop the loop; they are not swallowed by `continue`.

## Compatibility

- Changes are additive optional fields. Existing records without loop checkpoints still load; no schema-version bump, destructive migration, or history rewriting.
- Existing completed loops and unstarted loops retain their prior behavior. Legacy AI-instruction loops without body edges keep the compatibility path.
- A legacy interrupted structural loop with evidence of an effectful body having started/completed cannot be reconstructed safely from its last top-level state. Manual resume rejects it; claimed execution pauses before replay. The error explains that per-iteration history is missing and manual verification is required. No guessed checkpoint migration is performed.
- Pure/read-only legacy loops can continue under existing replay behavior; old data cannot supply nonexistent completed-iteration history.
- The loader validates nested checkpoint shape, integer/nonduplicate indices and IDs, JSON-compatible input/output, and nested node states. Malformed records follow the existing loader behavior of being excluded; no new deletion step was added.
- There is no downgrade migration: an older executor that does not understand checkpoints cannot provide the new recovery guarantees. Run unfinished checkpointed workflows with this version or newer.

## Verification

- Final focused command: `npx vitest run test/workflow/workflow-safe-execution.test.ts test/workflow/workflow-run-service.test.ts` — **96 passed, 2 files**.
- `npm run typecheck` — passed, exit 0.
- `git diff --check` — passed.
- Final `npm run test:workflow:p0` — **245 passed, 15 files** (after final recovery assertions).
- Initial P0 run under concurrent typecheck had one Python3 helper timeout: 241 passed / 1 failed. The helper reported `run did not finish in time`; there was no Python runtime error or Workflow assertion failure. Repeating P0 without simultaneous typecheck passed all 243 tests, including Python. No timeout/test implementation was changed to hide this result.
- P0 still emits the existing React `act` deprecation/environment warnings in renderer tests. These warnings were not changed by this task.

Additional verification extends initial RED cases: persisted incomplete-iteration completed-body outputs also survive reload; retry attempts are `[1, 2]` and retry events identify iteration 1; compensation inputs are B then A and a second compensation call does not repeat them; lost-lease release pauses nested dispatched effects; completed confirmed effects remain intact while unfinished read state resets to pending.

## Self-review and limits

- Reused the real WorkflowStore/RunStore/Worker/Service in tests. Only external connector and sub-workflow execution boundaries are injected; connector responses use their complete typed shape.
- Reviewed the effect-dispatch-to-output gap: nested confirmed-but-incomplete states are never automatically replayed.
- Reviewed body-complete-to-iteration-complete gap: persisted completed body output is reused and the iteration is finalized without dispatching it again.
- Reviewed retry of B after completed A: A is skipped, B retains the same key/attempt history, and no owner retry policy bypasses the body outcome.
- Reviewed invalid JSON behavior: the shared `WorkflowNodeOutputError` handling is retained, including raw output on failed state and stopping before downstream propagation. Existing diagnostic regression tests pass.
- Reviewed known-scope exclusions: no new loop concurrency, nesting or approval/form support; no UI edits; no automatic compensation/reconciliation of unknown effects.
- Remote systems must honor idempotency keys for idempotent write retry guarantees; this task does not claim exactly-once external execution for arbitrary APIs.
- Whole-run JSON persistence remains unchanged; adding per-iteration states increases record size within the existing iteration cap. No separate journal database or persistence redesign was introduced.

## Final result

Committed as `4c20f19` (`fix: make workflow loops recovery safe`). The commit contains exactly the five assigned production/test files. `.superpowers`, `.workbuddy-ai`, and all unrelated files were excluded. This report remains uncommitted as instructed. Final focused suite: 96 passed. Final P0 suite: 245 passed. Typecheck and diff whitespace validation passed.

## Review follow-up — handled final-item failures

Review supplied a reproducible Important finding: a `continue` loop whose last (or only) item fails completes its owner/output nodes, but leaves its top-level body inspection projection `failed`. The final run-wide `hasFailure` check interpreted that handled failure as an unhandled run failure.

RED: added two cases before implementation (A succeeds/B fails; only B fails). Both expected `completed` and received `failed`. Command: `npx vitest run test/workflow/workflow-run-service.test.ts -t 'final item fails'`; result **2 failed / 1 passed / 74 skipped**. The third case establishes that the same error in a stop loop still fails the run.

Fix: the final status check excludes body projections only when their owning loop both declares `failureStrategy: continue` and has completed. It does not exclude ordinary failed nodes or body states of incomplete/non-continue loops. No iteration states, top-level inspection errors, outputs, or events are erased. The new tests verify the completed error result, preserved failed nested/top-level body states, and scoped `node-failed` event.

GREEN:

- `npx vitest run test/workflow/workflow-safe-execution.test.ts test/workflow/workflow-run-service.test.ts`: **99 passed, 2 files**.
- `npm run test:workflow:p0`: **248 passed, 15 files**. Existing React act warnings remain; no failure/retry was needed for this review follow-up.
- `npm run typecheck`: passed, exit 0.
- `git diff --check`: passed, exit 0.

Review follow-up commit: `fc6542a` (`fix: preserve handled loop failure outcomes`). Only `src/main/workflow/workflow-run-service.ts` and `test/workflow/workflow-run-service.test.ts` are included; this appended report remains uncommitted.
