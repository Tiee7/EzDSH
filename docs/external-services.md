# External Services

EzDSH can manage optional user-owned processes from Settings → External services.
An external service is never part of the EzDSH or DSH Runtime startup success
path: enabled entries with `autoStart: true` are started asynchronously only
after the DSH Runtime reports `ready`. A failed or exited service is reported in
its own state and does not make EzDSH fail.

Entries with `enabled: true` and `autoStart: false` remain available for manual
Start, Stop, and Restart actions without starting automatically with EzDSH.

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
Enabled: on
Auto-start: on
```

External commands run with the current user's permissions. Only add commands
that the user trusts; the manager intentionally does not download or execute
service definitions from the Store.
