# External Services

EzDSH can manage optional user-owned processes from Settings → External services.
Adding a service automatically puts it under management; the only startup choice
is whether it should start with EzDSH.
An external service is never part of the EzDSH or DSH Runtime startup success
path: entries with `autoStart: true` are started asynchronously only after the
DSH Runtime reports `ready`. A failed or exited service is reported in its own
state and does not make EzDSH fail.

Entries with `autoStart: false` remain available for manual Start, Stop, and
Restart actions without starting automatically with EzDSH.

## Execution model

Commands are launched as an executable plus an argument array with Shell parsing
disabled. The settings form also accepts a common one-line command such as
`npm run dev` and splits it into an executable plus arguments. The child inherits
the current process environment and overlays the entry's configured variables.
Each process is owned by the main process and is stopped when EzDSH quits or
installs an update.

Configuration is stored in the per-user state directory:

```text
<userData>/state/external-services.json
```

Child stdout and stderr are appended to:

```text
<userData>/logs/external-services/<service-id>.log
```

The settings page reads one snapshot when it opens and subscribes to process
events while it remains mounted. EzDSH does not poll external services or send
process updates to the renderer when the management page is closed.

## Recovering from a startup failure

EzDSH checks the working directory before attempting to start the command. The
failure message distinguishes a missing folder, a path that is a file, and a
folder it cannot access. Where executable lookup can be verified, it also
distinguishes a missing command from a command that cannot run. A missing script
interpreter or a broken symbolic link is not treated as proof that the command
has not been installed. Original process errors remain available under Failure
details.

Choose **Change working directory** or **Change start command** beside the
diagnosis. The corresponding field receives focus. **Choose folder** changes
only the draft; **Save and retry** first saves the settings and then attempts to
start that service. Canceling or failing to save does not start it. Ordinary
Add/Edit → Save still saves without starting.

Clearing the working directory removes its previous value and returns to
inheriting EzDSH's process directory. An explicit `~` or `~/...` is resolved
against the current user's home directory; relative directories are resolved
against the current process directory. Environment variables and other Shell
expressions in the directory are not expanded. EzDSH never creates a missing
service directory or changes its permissions as part of this check.

Diagnostics belong to the current launch attempt, not persisted configuration.
Changing process settings clears the previous diagnosis. A running state still
indicates a created process rather than an application-specific health check.
Windows executable lookup is reported conservatively when absence or execute
permissions cannot be proven; Windows packaged behavior needs platform testing.

## Workbench example

The Workbench can be registered as an external service with values equivalent to:

```text
Command: node
Arguments:
  /absolute/path/to/workbench/server.js
Working directory: /absolute/path/to/workbench
Environment:
  PORT=3456
  EZDSH_API_URL=http://127.0.0.1:53260
  WORKBENCH_DATA_DIR=/path/to/user/workbench-data
Auto-start: on
```

External commands run with the current user's permissions. Only add commands
that the user trusts; the manager intentionally does not download or execute
service definitions from the Store.
