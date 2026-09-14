# Task 5 implementation report

Status: COMPLETE

## Result

- Added `WorkflowEffectReconcileRequest` and `workflowRuns.reconcileEffect(runId, request)` through shared contract, preload, Main IPC and service. IPC and direct service calls both validate request shape, outcome, IDs and 1–500 trimmed note characters.
- Only paused/failed runs and an exact unknown target are eligible. Ordinary lookup excludes loop projections. Iteration lookup uses the durable owner/iteration/node journal and emits its full execution scope.
- `not-dispatched` resets only the selected target to pending/none. The decision, reset and queue transition share one `service.save` snapshot and notify watchers. Completed loop iterations remain durable and are not replayed.
- Following controller clarification, when other prepared/dispatched/unknown or incomplete confirmed effects remain, the individual decision is saved while the run remains paused. The final safe resolution revalidates current environment access and atomically requeues.
- `dispatched` records confirmed evidence, sets target/run failed, supplies no fabricated output and never wakes downstream execution. Existing resume semantics reject confirmed non-completed targets. No compensation action is inferred or executed.
- Concurrent reconciliation requests for the same run are excluded; resume/compensate cannot overlap an in-flight reconciliation save.
- Private state stores `effectReconciliation` as latest plus append-only `effectReconciliationHistory`. A single helper updates both. Repeated decisions on the same target retain all notes after reload.
- Added explicit `node-effect-reconciled-not-dispatched` and `node-effect-reconciled-dispatched` events. Event messages use fixed text; notes stay in run-state audit fields. Required observability allowlist/kind/outcome wiring classifies these as effect/succeeded, describing the recorded decision rather than successful run execution. Observation metadata excludes note text.

## TDD evidence

1. Added service and shared validation tests before production changes. Focused RED: 15 new failures (`reconcileEffect` / validator not functions), 86 existing tests passed.
2. Added multi-unknown and concurrent-decision tests after controller clarification. Corrected one fixture setup error, then observed both expected missing-method failures before implementation.
3. Initial GREEN: 103 focused tests passed.
4. New event union exposed an exhaustive observability switch in typecheck. Added observation persistence and private-note tests; RED showed invalid observation event and note copied into message. Implemented minimal observation classification/allowlist and fixed event text.
5. Added same-target repeated-decision + disk-reload test before history implementation. RED: undefined history instead of two decisions. Implemented append-only history helper, then reran verification.

## Final verification

- `npx vitest run test/workflow/workflow-run-service.test.ts test/workflow/workflow-operations.test.ts`: 2 files, 105 tests passed.
- `npm run test:workflow:p0`: 15 files, 278 tests passed. Existing React act deprecation/environment warnings remain; no failures.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Scope and handoff

Nine source/test files changed, including the two minimal observation files required by the new event union. No UI, automatic external query, automatic compensation, or edits to other task reports/progress/workbuddy files. This report is intentionally not staged.

UI consumers can read `effectReconciliation` for the latest decision and `effectReconciliationHistory` for the full private audit. For loop targets, use owner `loopIterations[].iterationId` with nested `nodeStates[].nodeId`; ordinary top-level loop summaries are not valid targets.

## Review follow-up: interrupted safe branches and active execution

- Verified the recovery defect: `recoverInterruptedRuns` pauses uncertain effects as unknown/cancelled while unrelated pure branches and loop owners can remain running. The Worker schedules pending nodes only, so resetting the effect target alone could strand those branches.
- Final safe `not-dispatched` requeue now also normalizes interrupted running/failed/cancelled states with no unsafe effect to pending and clears their stale execution fields. Completed nodes and completed loop iterations are preserved. Intermediate decisions with other unresolved effects do not reset unrelated branches.
- Reconciliation now rejects runs present in the service's active execution map, even when a branch has already persisted a paused snapshot. Once execution cleanup completes, genuinely stopped paused runs remain eligible.
- TDD RED: three crash-checkpoint/recovery tests failed because pure statuses stayed running/failed/cancelled; two live parallel-branch tests failed because both reconciliation outcomes were accepted while the AI branch was still in flight.
- TDD GREEN: all five regressions passed. Recovery tests load the persisted claimed checkpoint into a fresh service, exercise real recovery and Worker execution, confirm only unfinished iteration B executes, and preserve completed effect iteration A. Concurrency tests use a controlled real parallel connector/AI run and release/stop the Worker normally; they do not manipulate private maps.
- Final verification: focused 110/110; P0 283/283 across 15 files; typecheck and diff check passed. Existing React act warnings only.
- Follow-up implementation scope: `src/main/workflow/workflow-run-service.ts` and `test/workflow/workflow-run-service.test.ts`; this report remains unstaged.
