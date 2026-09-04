RED

- Added `test/workflow/workflow-deployment-service.test.ts` first, before implementation.
- First RED verification command:

```text
$ npx vitest run test/workflow/workflow-deployment-service.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

FAIL  test/workflow/workflow-deployment-service.test.ts
Error: Cannot find module '../../src/main/workflow/workflow-deployment-service.js'

Test Files  1 failed (1)
Tests  no tests
```

GREEN

- Created `src/main/workflow/workflow-deployment-service.ts` with `publish(input)`, `start(releaseId,input,options)`, and `rollback(releaseId)`.
- Extended `src/main/workflow/workflow-run-service.ts` with Main-only `startReleased(releaseId,input,options)` plus `resolveReleasedWorkflow` support.
- Release-backed runs now resolve workflow snapshots from immutable releases instead of falling back to the current editable workflow store.
- Release-backed run records now persist `environmentId`, `releaseId`, and generated `traceId`, while connector grants remain narrowed to the release/environment intersection.

验证

```text
$ npx vitest run test/workflow/workflow-deployment-service.test.ts
RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh
✓ test/workflow/workflow-deployment-service.test.ts (6 tests)
Test Files  1 passed (1)
Tests  6 passed (6)
```

```text
$ npx vitest run test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts test/workflow/workflow-worker-integration.test.ts test/workflow/workflow-release-store.test.ts test/workflow/workflow-operations.test.ts
RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh
✓ test/workflow/workflow-operations.test.ts (7 tests)
✓ test/workflow/workflow-release-store.test.ts (8 tests)
✓ test/workflow/workflow-deployment-service.test.ts (6 tests)
✓ test/workflow/workflow-worker-integration.test.ts (5 tests)
✓ test/workflow/workflow-run-service.test.ts (52 tests)
Test Files  5 passed (5)
Tests  78 passed (78)
```

```text
$ npm run typecheck
> ezdsh@1.8.1536 typecheck
> tsc --noEmit -p tsconfig.node.json
exit 0
```

commit hash

- `58dc844c1991724158fa3720a996fdf3f0ac77c9`

concerns

- `WorkflowRunServiceOptions.resolveReleasedWorkflow` is implemented and covered in tests, but app-level wiring to construct and expose deployment services is still separate work.

---

Review Round 2

RED

- Added a failing idempotency regression test to `test/workflow/workflow-safe-execution.test.ts` proving the same `workflowId + workflowRevision + idempotencyKey` must not deduplicate across different `releaseId` or `environmentId`.
- Added a failing deployment regression test to `test/workflow/workflow-deployment-service.test.ts` proving a parent release without top-level connectors must still publish child managed-connector grants and pass them into the child run.

```text
$ npx vitest run test/workflow/workflow-safe-execution.test.ts test/workflow/workflow-deployment-service.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

FAIL  test/workflow/workflow-deployment-service.test.ts
  expected [] to deeply equal [{ connectorId: 'api', operations: ['read'] }]

FAIL  test/workflow/workflow-safe-execution.test.ts
  expected 'run-release-a' to be 'run-release-b'

Test Files  2 failed (2)
Tests  2 failed | 20 passed (22)
```

GREEN

- Updated `src/main/workflow/workflow-run-store.ts` so explicit idempotency equivalence now includes `environmentId` and `releaseId`, while ad-hoc runs still deduplicate as before when both are absent.
- Updated `src/main/workflow/workflow-deployment-service.ts` to recursively resolve sub-workflows during publish, reject cyclic/missing child references via workflow resolution, collect descendant managed connector grants allowed by the target environment, and merge those grants into the release snapshot policy so release integrity stays valid.
- Kept release context out of public `WorkflowRunOptions` and IPC surfaces; grant propagation still rides on the existing internal `startReleased` and `executeSubWorkflow` path.

```text
$ npx vitest run test/workflow/workflow-safe-execution.test.ts test/workflow/workflow-deployment-service.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

✓ test/workflow/workflow-deployment-service.test.ts (7 tests)
✓ test/workflow/workflow-safe-execution.test.ts (15 tests)

Test Files  2 passed (2)
Tests  22 passed (22)
```

验证

```text
$ npx vitest run test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts test/workflow/workflow-worker-integration.test.ts test/workflow/workflow-release-store.test.ts test/workflow/workflow-operations.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

✓ test/workflow/workflow-operations.test.ts (7 tests)
✓ test/workflow/workflow-release-store.test.ts (8 tests)
✓ test/workflow/workflow-worker-integration.test.ts (5 tests)
✓ test/workflow/workflow-deployment-service.test.ts (7 tests)
✓ test/workflow/workflow-run-service.test.ts (52 tests)

Test Files  5 passed (5)
Tests  79 passed (79)
```

```text
$ npm run typecheck
> ezdsh@1.8.1536 typecheck
> tsc --noEmit -p tsconfig.node.json
exit 0
```

```text
$ git diff --check
exit 0
```

commit hash

- `4cabffbd559abeeffe3bebbfc5c47762187a5d45`

concerns

- Descendant connector permissions are now merged into the immutable release snapshot policy to satisfy release-integrity invariants. This is confined to the release snapshot and does not mutate the source workflow, but it does mean a parent release snapshot can advertise connectors that are only consumed by pinned descendants.

---

Review Round 3

RED

- Added failing release-integrity coverage in `test/workflow/workflow-operations.test.ts` and `test/workflow/workflow-release-store.test.ts` for dependency snapshots being part of the immutable digest.
- Added a failing deployment regression in `test/workflow/workflow-deployment-service.test.ts` proving a published parent release must keep running against the published child snapshot after the child source workflow is updated or removed, and must reject missing/cyclic child dependencies.

```text
$ npx vitest run test/workflow/workflow-operations.test.ts test/workflow/workflow-release-store.test.ts test/workflow/workflow-deployment-service.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

FAIL  test/workflow/workflow-operations.test.ts
  TypeError: (0 , computeWorkflowReleaseSha256) is not a function

FAIL  test/workflow/workflow-release-store.test.ts
  TypeError: (0 , computeWorkflowReleaseSha256) is not a function

FAIL  test/workflow/workflow-deployment-service.test.ts
  expected undefined to deeply equal [ 'workflow-child-pinned@1' ]

Test Files  3 failed (3)
Tests  4 failed | 22 passed (26)
```

GREEN

- Extended `WorkflowRelease` normalization/integrity so `workflowDependencies` are normalized, cloned, and included in a release-wide SHA-256 digest, while root-only releases remain compatible.
- Updated `src/main/workflow/workflow-release-store.ts` to clone/persist dependency snapshots and reject persisted releases whose dependency snapshots no longer match the saved digest.
- Reworked `src/main/workflow/workflow-deployment-service.ts` publish flow to recursively collect pinned sub-workflow snapshots, reject missing/cyclic descendants, pin sub-workflow versions inside release snapshots, and carry descendant managed connector grants into the immutable release grant ceiling.
- Updated `src/main/workflow/workflow-run-service.ts` so release-backed runs resolve both root and dependency definitions from the immutable release, and release-backed sub-workflow nodes execute pinned child snapshots instead of drifting back to the live workflow store.

```text
$ npx vitest run test/workflow/workflow-operations.test.ts test/workflow/workflow-release-store.test.ts test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

✓ test/workflow/workflow-operations.test.ts (8 tests)
✓ test/workflow/workflow-release-store.test.ts (9 tests)
✓ test/workflow/workflow-deployment-service.test.ts (9 tests)
✓ test/workflow/workflow-run-service.test.ts (52 tests)

Test Files  4 passed (4)
Tests  78 passed (78)
```

验证

```text
$ npx vitest run test/workflow/workflow-deployment-service.test.ts test/workflow/workflow-run-service.test.ts test/workflow/workflow-worker-integration.test.ts test/workflow/workflow-release-store.test.ts test/workflow/workflow-operations.test.ts test/workflow/workflow-safe-execution.test.ts --testTimeout=20000

RUN  v3.2.7 /Users/snake/Documents/ChatGPT/ezdsh

✓ test/workflow/workflow-operations.test.ts (8 tests) 18ms
✓ test/workflow/workflow-release-store.test.ts (9 tests) 73ms
✓ test/workflow/workflow-worker-integration.test.ts (5 tests) 218ms
✓ test/workflow/workflow-deployment-service.test.ts (9 tests) 358ms
✓ test/workflow/workflow-run-service.test.ts (52 tests) 968ms
✓ test/workflow/workflow-safe-execution.test.ts (15 tests) 2119ms

Test Files  6 passed (6)
Tests  98 passed (98)
```

```text
$ npm run typecheck -- --pretty false
> ezdsh@1.8.1536 typecheck
> tsc --noEmit -p tsconfig.node.json --pretty false
exit 0
```

```text
$ git diff --check
exit 0
```

commit hash

- `a4d16ba4cc5b89d7a08848d0b2b34c8c4de7c273`

concerns

- No new functional concerns beyond the release snapshot now explicitly carrying descendant workflow definitions as Main-only immutable data.

---

## DSH Runtime RC1 RPC compatibility hardening

### Verified contract

- The published `dsh-v0.1.2-rc.1` source uses slash RPC routes with an outer
  `payload: { args: ... }` envelope. Session/workspace commands receive named
  `request` arguments; `session/list` instead receives `_request`; the model
  catalog is `session/modelCatalog`; history is `session/page` and needs a
  session address plus an exact `throughSeq` cursor.
- Legacy unary workspace list/unarchive and per-session model routes are not
  present in RC1. The main-process client now rejects those calls explicitly
  instead of calling invented/removed routes. Prompt completion likewise
  reports that RC1 requires `session/follow`, rather than silently polling the
  removed history endpoint.

### TDD and security fixes

- Added failing mapping tests before implementation, then mapped supported
  public operations to the RC1 routes and argument shapes while preserving all
  clean-URL legacy fixtures.
- Added failing readiness tests for a 303 without `dsh-auth-*` and a token URL
  that returns 200. Tokenized Runtime readiness now requires exactly the 303
  exchange and the auth-cookie family.
- Runtime output retains the tokenized URL only in memory; the persisted
  `harness.log` redacts `token=` values.

### Verification

- `npx vitest run test/runtime/health-check.test.ts test/runtime/runtime-manager.test.ts test/channel-bridge/dsh-session.test.ts`
  - passed: 3 files, 38 tests.
- `git diff --check`
  - passed.
- `npm run typecheck`
  - attempted; currently blocked by in-progress, out-of-scope edits in
    `src/main/notifications/runtime-notification-service.ts` at line 162
    (`summary` possibly undefined). This task did not modify that file.
