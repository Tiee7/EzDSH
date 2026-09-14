# Task 1: Release access revalidation

## RED evidence (before production edits)

Command: `npx vitest run test/workflow/workflow-operations.test.ts test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts`

Run at 2026-09-11 14:35:37 Asia/Shanghai; exit 1. Result: 3 failed files; 14 failed, 72 passed tests (86 total).

Observed failures:

- Shared policy contract: `restrictConnectorGrantsToEnvironment is not a function` (new required API absent).
- Both deployment-start revocation cases: `expected [ { connectorId: 'crm', ... } ] to deeply equal []`.
- Disabled/archived direct release starts and disabled resume/approve/compensate: `promise resolved ... instead of rejecting`.
- Start and continuation capability narrowing: received `allowCode: true, allowShellFile: true`, expected both false.
- Both durable-worker revocation cases: `expected 'completed' to be 'failed'`. Real connector authorization allowed dispatch after revocation with the old run grant.

All existing tests and approval-rejection compatibility passed. No production file had been edited at this point.

The deployment parameter table was subsequently clarified to pass a named `connectorGrants` field, and the compensation executor test double received its actual interface type. The same command was rerun before production edits at 14:36:14: exit 1, again 14 failed and 72 passed. Both requested-grant variants reproduced the revoked-connector assertion failure.

## Implementation

- Added `restrictConnectorGrantsToEnvironment`: filter existing grants against the current connector allowlist and clone retained operation arrays.
- Deployment start now restricts the immutable release grant by current environment before applying caller-requested narrowing.
- Added optional synchronous `resolveWorkflowEnvironment` to `WorkflowRunServiceOptions` and wired the initialized Main environment store into it.
- Released definition start, resume, approve-true, compensate, and worker execution re-read the environment; missing/non-active environments reject execution.
- Successful revalidation intersects saved run grants with release grants and current environment, and ANDs existing shell/file and code capabilities with current environment flags. This preserves narrower operation grants and does not restore removed capabilities when the environment later expands.
- Approval rejection remains usable for disabled environments. Legacy live runs and compatibility embeddings without the optional environment resolver preserve their current behavior.
- FDE node set and existing production deployment node gates are unchanged.

## Tests added

15 test cases across the three required suites:

- Shared restriction removes revoked connectors, does not add operations/connectors, and clones operation arrays.
- Deployment start drops a connector revoked after publishing both with default grants and explicit requested grants; the immutable release remains unchanged.
- Direct release starts reject disabled and archived environments and narrow all current capability types.
- Disabled resume, approve-true, and compensate reject without mutating the stored record or invoking compensation.
- Approval rejection remains available under environment disablement.
- Resume, approval, and compensation narrow capability flags and retain operation-level narrowing; subsequent connector removal and re-addition do not resurrect run grants or capability flags.
- Durable queued releases are checked after disablement or connector revocation and fail before any HTTP dispatch. These use real stores, real worker lifecycle, and real connector authorization; only network fetch is a fake boundary.

## GREEN verification

`npx vitest run test/workflow/workflow-operations.test.ts test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts`

- 2026-09-11 14:37:20 Asia/Shanghai; exit 0.
- 3 files passed; 86 tests passed (9 operations, 11 deployment, 66 run-service); duration 1.31s.

`npm run typecheck`

- Exit 0 (`tsc --noEmit -p tsconfig.node.json`).

`git diff --check`

- Exit 0; no whitespace errors.

## Task files changed

- `src/shared/workflow-operations.ts`
- `src/main/workflow/workflow-deployment-service.ts`
- `src/main/workflow/workflow-run-service.ts`
- `src/main/index.ts`
- `test/workflow/workflow-operations.test.ts`
- `test/workflow/workflow-deployment-service.test.ts`
- `test/workflow/workflow-run-service.test.ts`

This report is a separate requested handoff artifact. The plan, ledger, `.workbuddy-ai/`, and unrelated files are not staged.

## Self-review and concerns

- Confirmed all five specified run-service execution boundaries call the shared revalidation method and Main passes the live environment resolver.
- Checked fail-before-state-mutation behavior for disabled continuations, grant cloning, immutable release preservation, durable queue recovery, and existing production gates.
- Optional resolver omission intentionally preserves embedding compatibility; Main always provides it.
- Revalidation applies at the requested boundaries. It is not an in-flight kill switch for a node already executing when policy changes.
- No blocking implementation concerns found. Required focused tests and Main typecheck passed; no packaged-app/UI run was needed or performed for this backend change.

## Commit

Commit hash: `8e60df0`. Message: `fix: revalidate workflow release access`.

The implementer could not write the Git index because its escalation timed out; the parent agent staged the exact seven task files and created the commit after the test and diff evidence above was verified. Independent task review found no Critical or Important issues.
