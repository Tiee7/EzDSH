# Task 4 Report

Date: 2026-09-03

RED

- The generated brief expected the observation tests to fail before implementation, but the workspace already contained a working Task 4 implementation by the time I picked up the task.
- A full repo `tsc` run did not complete in this environment. It first hit Node heap limits, and with a larger heap it surfaced many unrelated baseline errors, including pre-existing renderer and `vendor/deepseek-harness` type errors.

GREEN

- Added `WorkflowObservationStore` with append-only JSONL persistence, private directory/file permissions, restart recovery, clone isolation, environment filtering, and event-id deduplication.
- Added `WorkflowObservabilityService` with safe run-event mapping, redaction by construction, deployment recording, and health summarization.
- Extended `WorkflowObservationEvent` with a safe optional `nodeId`.
- Allowed `recordDeployment` to accept either explicit deployment metadata or a `WorkflowRelease`, mapping release status to deployment action.

REVIEW FIX

- `recordDeployment(WorkflowRelease)` no longer reuses `release.id` as the observation id.
- Release lifecycle observations now use the actual call time or an explicit lifecycle time override, so published/superseded/rolled-back events stay distinct.

VERIFICATION

- `npx vitest run test/workflow/workflow-operations.test.ts test/workflow/workflow-observation-store.test.ts test/workflow/workflow-observability-service.test.ts` passed.
- `npx vitest run test/workflow/workflow-observation-store.test.ts test/workflow/workflow-observability-service.test.ts` passed after the review fix.
- `NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit` failed on pre-existing baseline issues outside the Task 4 scope.

COMMIT

- `3058fdb fix: separate workflow release deployment observations`
