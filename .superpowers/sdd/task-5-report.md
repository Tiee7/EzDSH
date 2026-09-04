# Task 5 Report: Workflow release, observability, and customer environments

## Implementation

- Added `workflowEnvironments`, `workflowReleases`, and `workflow-observability` IPC surfaces in `src/shared/contracts.ts` and `src/preload/index.ts`.
- Wired `src/main/index.ts` to compose `WorkflowEnvironmentStore`, `WorkflowReleaseStore`, `WorkflowDeploymentService`, `WorkflowObservationStore`, and `WorkflowObservabilityService` only for the active local workspace.
- Observed workflow run records from the Main-process watcher into append-only redacted observations.
- Added a renderer `WorkflowReleasePanel` in `src/renderer/workflow/WorkflowPage.tsx` to create/select a customer environment, publish the current workflow revision, start a published release, roll back a release, and view redacted health/observation history.
- Styled the new release/observation section in `src/renderer/workflow/workflow.css`.
- Updated `docs/product-requirements.md` so the supported-capability list now includes local workflow publishing, rollback, customer environments, and health observation instead of describing release flows as absent.

## Review correction

- `WorkflowObservabilityService.health()` now reports `release-rolled-back` as `degraded`, matching the task contract and keeping rollback distinct from failure-driven `unhealthy` states.

## Verification

- `npx vitest run test/renderer/workflow-page.test.tsx test/workflow/workflow-observation-store.test.ts test/workflow/workflow-observability-service.test.ts`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

## Notes

- Renderer-visible release data stays summary-only. No release snapshot, runtime input/output, raw response body, credential plaintext, or authorization header is exposed through IPC.
- The repository already contains broad workflow/documentation coverage for the earlier queue/idempotency/release work, so this task only had to close the workflow publish/observe UI and product wording gap.

## RC1 session-flow correction (2026-09-04)

- Restored production modern-Runtime chat in `DshSessionClient`: RC1 history now resolves the matching `session/list` projection `asOfSeq` cursor before calling `session/page` with the ordinary-session address.
- Removed the modern-mode prompt-completion compatibility throw. Prompt sending retains its required generated `requestId`, acknowledgement, delta, progress, timeout, and completion behavior by using that list/page cursor flow before and after queuing the prompt.
- RC1 page records are normalized into the existing history-entry shape, while legacy HTTP routes retain their previous caller-supplied history behavior.
- Added focused tests that assert both the list-to-page wire arguments and the complete modern prompt/list/page poll sequence, including the generated prompt `requestId`.

### Verification

- `npx vitest run test/channel-bridge/dsh-session.test.ts`
- `npm run typecheck`
- `git diff --check`
