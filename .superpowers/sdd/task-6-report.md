# Task 6 Report: Align DSH plugin expectations with RC1

## Implementation

- Updated `test/store/dsh-plugin-command.test.ts` to reflect the intentional
  `@deepseek-ai/dsh` pin at `0.1.2-rc.1`.
- The bundled-runtime command assertion now expects RC1 to forward plugin
  arguments without the legacy `-w` workspace-root workaround.
- The install-log assertion now expects `dshVersion=0.1.2-rc.1` and
  `workspaceRootWorkaroundApplied=false`.
- Kept the explicit `0.1.1-rc.2`/workspace-marker compatibility unit tests as
  documentation and regression coverage for the legacy behavior.

## Commit

`test: align dsh plugin expectations with rc1`

## Verification

- `npx vitest run test/store/dsh-plugin-command.test.ts`
  - Passed: 1 file, 7 tests.
- `git diff --check`

## Scope

Only the existing test expectations and this report were changed. No source
implementation or progress tracking file was modified.
