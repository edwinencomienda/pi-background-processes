# Pi Background Processes

A Pi package that adds a `background_process` tool for managing long-running local processes like dev servers, API servers, workers, and docs servers.

## Install

```bash
pi install git:github.com/edwinencomienda/pi-background-processes
```

Then restart Pi or run `/reload`.

For one-off testing without installing:

```bash
pi -e git:github.com/edwinencomienda/pi-background-processes
```

## What it adds

- `background_process` tool with `start`, `stop`, `status`, `list`, `logs`, and `forget` actions.
- Shared process records across Pi agents on the same machine.
- `scope` support for `list`: `project` (default), `owned`, or `all`.
- `/processes` command to show project-scoped tracked processes in a widget.
- `/processes-clear` command to hide the widget.
- Footer indicator while managed processes are running.
- Cascading shutdown: processes started by a Pi session are stopped when that Pi session quits or switches sessions. `/reload` keeps them alive.

## Example prompts

```text
start the dev server with npm run dev
show background processes for this project
show all managed background processes
show logs for the devserver
stop the devserver
```

`/processes` defaults to the current project, so multiple Pi agents working in the same repo can see the same managed dev server. Use `/processes all` to show every managed process on the machine, or `/processes owned` to show only processes started by the current Pi session.

The tool stores PID files and logs under:

```text
~/.pi/agent/background-processes/
```

## Notes

Processes are spawned detached and killed by process group when stopped, so child processes created by dev servers are cleaned up too.
