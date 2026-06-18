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
- `/processes` command to show tracked processes in a widget.
- `/processes-clear` command to hide the widget.
- Footer indicator while managed processes are running.
- Cascading shutdown: processes started by a Pi session are stopped when that Pi session quits or switches sessions. `/reload` keeps them alive.

## Example prompts

```text
start the dev server with npm run dev
show logs for the devserver
stop the devserver
```

The tool stores PID files and logs under:

```text
~/.pi/agent/background-processes/
```

## Notes

Processes are spawned detached and killed by process group when stopped, so child processes created by dev servers are cleaned up too.
