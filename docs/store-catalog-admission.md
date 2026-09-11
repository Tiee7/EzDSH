# Store plugin catalog admission

Static audit and installability are different checks:

- static audit checks the source shape and suspicious content;
- admission runs the actual package manager in an isolated temporary project;
- only the exact source that passes that install test may be published as a
  DSH plugin entry.

The verifier must use the same DSH and pnpm versions shipped to users. It
installs lifecycle scripts under the default policy, checks the installed
manifest name, and requires `dsh.bundle`. If a build script needs an explicit
exception, pass the exact package spec with `--allow-build` and keep that
exception in the catalog verification record.

Example:

```bash
npm run verify:store:plugin -- \
  --source github:owner/repository#v1.2.3 \
  --package-name example-plugin \
  --dsh-version 0.1.5-rc.1 \
  --pnpm-version 11.7.0 \
  --json
```

The JSON result is stored by the catalog service as `plugin.verification`.
`status: "passed"`, the exact matching source, a valid timestamp, the tested
DSH/pnpm versions, and the same package name as `plugin.packageName` are
mandatory. Missing or failed verification is rejected by the client as well,
so stale or manually inserted entries cannot silently reach the install
command.

This check is evidence for a specific source and toolchain, not a permanent
guarantee: a mutable Git ref, disappearing registry release, or upstream
dependency change requires a new verification and catalog version.
