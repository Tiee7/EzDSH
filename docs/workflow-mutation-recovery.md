# Workflow local mutation recovery

The single Main process shares one writer coordinator per state directory. The
coordinator supports exactly two operations: saving editable definitions with
their immutable versions, and deleting an editable definition and/or an exact
set of run records. It is not a general transaction engine or a multiprocess
lock. Multiple independently cached store owners for the same files and external
file writers are unsupported.

The fixed `workflow-mutation-intent.json` file contains schema version 1, an
operation UUID, the operation kind, and ordered after-images for a fixed enum of
state files. Every image has an SHA-256 before/after digest. Recovery accepts only
those two states; malformed schemas, invalid images, digest conflicts, and
symlink participants stop startup. Intent recovery precedes store loading,
legacy repair, lease recovery, pruning, and Worker start.

Save ordering is intent, versions, definitions, intent removal, then publishing
memory. Delete ordering is intent, permanent tombstones, editable definitions,
archival versions, exact run snapshot, intent removal, then publishing memory.
Reads retain the old committed view until publication. I/O failure after intent
publication blocks subsequent writes and requires roll-forward on a new Main
startup; the old memory view is not a claim that disk was rolled back. Recovery
can itself fail and be retried from any already-written image.

Deletion rechecks active runs under the shared writer. Both ends of all persisted
parent/child and compensation `childRunId` / `childRunIds` references are retained,
including nested loop states. An unknown legacy reference conservatively retains
all run history. Retained runs require the exact revision to exist. Historical
versions are retained conservatively because release and transitive workflow pins
are owned outside this operation. Versions never recreate editable definitions.
Protected references also prevent single-run removal and retention pruning.

Workflow IDs cannot recreate tombstoned editable definitions, and deleted run IDs
cannot be reused. A previously published immutable release can still execute
after its editable source was deleted, under the existing release integrity and
authorization checks. Pending or failed cross-file mutations block all new writes.

State directories use mode 0700 and newly written files use mode 0600. Writes use
temporary files and rename without fsync, so the supported guarantee is recovery
after a process crash, **not power-loss durability**. Tombstones and conservatively
retained versions currently have no garbage collector.

Tests cover each save/delete file boundary, failure while clearing intent,
repeated recovery after another failure, unchanged committed memory on failure,
schema/hash/conflicting-content/symlink rejection, exact run tombstones and ABA,
compensation reference protection, and old array/envelope compatibility.
