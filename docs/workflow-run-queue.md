# Local Workflow admission and scheduling

The Electron Main process owns one durable run store and one Worker. Admission
defaults are **1,000 global** and **100 per environment**. The Main-only
`DEFAULT_WORKFLOW_RUN_QUEUE_LIMITS` in `src/main/workflow/workflow-run-store.ts`
is the configuration source; a Main embedding can supply validated positive
safe integers to the store constructor. Invalid values fail with
`WORKFLOW_RUN_QUEUE_CONFIG_INVALID`. Renderer run options cannot change limits.

## Admission

`queued`, `running`, and `waiting-approval` consume admission slots, including
delayed retries and synchronous children. `paused`, `completed`, `failed`, and
`cancelled` do not. Released runs use their immutable release environment;
all runs without an environment share one local bucket. A real environment
named `local` has a separate bucket.

Every serialized store mutation checks old and new global and bucket counts
before the atomic file write, including direct saves, child creation, resume,
and reconciliation. A positive delta beyond a configured limit rejects with
`WORKFLOW_RUN_QUEUE_FULL`. The error exposes no customer IDs or payloads.
Idempotent duplicate enqueue lookup precedes admission and returns the original
run even at capacity. Counted-state transitions do not reserve another slot.

Existing over-limit data is retained and can drain; limits are never widened
automatically. A rejected resume or final not-dispatched reconciliation retains
the entire prior record and audit log. A rejected child creation fails promptly
and releases its temporary lineage, without treating the nonexistent child as an
unknown external effect. Already admitted children and parents still follow the
existing conservative effect-recovery rules.

## Scheduling and metrics

Each claim chooses the next due environment bucket after the persisted cursor
in deterministic string order, wrapping when necessary. Delayed-only buckets
are skipped. Within a bucket, due runs sort by `availableAt`, then `enqueuedAt`,
then run ID. The chosen cursor and Worker lease commit in the same snapshot and
roll back together on a write failure. For a fixed set of due buckets, each gets
one claim per round, including when Main restarts between successful claims.

The operational-health response includes global counts and counts for its exact
queried environment once stores are initialized. Metrics contain capacity,
admitted/queued/running/waiting-approval counts, remaining slots clamped to zero,
and whether existing data exceeds the limit. They include no other environment
IDs, run IDs, raw errors, inputs, or release snapshots. Remaining bucket slots do
not override a full global limit; both must allow an admission.

## Disk format and upgrade boundary

`workflow-runs.json` accepts legacy arrays. The next successful mutation writes
an envelope with `schemaVersion: 1`, `runs`, and optional `lastClaimedBucket`.
Read-only initialization does not rewrite the file. Unknown versions and malformed
envelopes fail closed with `WORKFLOW_RUN_STORE_SCHEMA_UNSUPPORTED`; Main must not
overwrite them with an empty store. Legacy individual-record validation remains
unchanged.

**Downgrading to an array-only application is not safe after migration.** Older
code may treat the envelope as empty. Stop Main first and preserve an offline
backup before any downgrade. Use a compatible build, or perform an explicitly
reviewed offline conversion of the envelope's `runs` array after checking leases
and recovery state. Such conversion loses the fairness cursor and the older
build also loses these admission guarantees. No automatic downgrade/conversion
is performed.

This is a single-process count bound and claim-order policy. It does not bound
history size or bytes on disk, coordinate concurrent Main processes, preempt a
long-running workflow, or promise a scheduling-time SLA. Synchronous children
hold their parent's slot and need an additional admission slot; at a full queue
they fail rather than wait for capacity while occupying the Worker.
