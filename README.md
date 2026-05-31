# pi-persistent-term

Integrated terminal panel for the [pi coding agent](https://github.com/badlogic/pi-mono). Provides a persistent PTY shell inside pi — state (cwd, virtualenvs, environment variables) survives across calls, unlike pi's built-in `bash` tool which spawns a fresh subshell each time.

## Features

- **Persistent shell** — `cd`, `source .venv/bin/activate`, `export`, etc. all carry over between calls
- **Terminal overlay** — `/term` or `Ctrl+\`` opens a full-color interactive panel, `Ctrl+Q` returns to pi
- **LLM tools** — `run_in_terminal`, `write_terminal`, `read_terminal` let the LLM drive the shell
- **Context injection** — recent terminal output is automatically prepended to every LLM prompt
- **Colored display** — uses `@xterm/headless` for proper terminal emulation in the overlay
- **Scrollback** — `PgUp`/`PgDn` to scroll, `Shift+PgUp`/`Shift+PgDn` for fine scroll

## Installation

```bash
git clone https://github.com/vahidkowsari/pi-persistent-term
cd pi-persistent-term
npm install
pi install .
```

## Commands

| Command | Description |
|---|---|
| `/term` | Open terminal overlay |
| `/term-clear` | Clear the terminal buffer |
| `/term-restart` | Restart the terminal shell process |
| `/term-context` | Toggle auto-injecting terminal output into LLM prompts |
| `/monitor-stop` | Stop the currently monitored background process |
| `Ctrl+\`` | Shortcut to open terminal overlay |

## Keybindings (inside overlay)

| Key | Action |
|---|---|
| `Ctrl+Q` | Close overlay, return to pi |
| `Ctrl+C` | Interrupt running process |
| `PgUp` / `PgDn` | Scroll by page |
| `Shift+PgUp` / `Shift+PgDn` | Scroll by 5 lines |

## LLM Tools

### `monitor_process`

Start, stop, or check a background process monitor. Output is captured from a child process (separate from the PTY shell) and can optionally be pushed into the conversation in real-time.

```
# Silent mode — output buffered, readable via read_terminal
monitor_process(action="start", command="npm run build -- --watch")

# React mode — each output chunk triggers a new LLM turn
monitor_process(action="start", command="pytest tests/ -v", react=True)

# Stop the monitor
monitor_process(action="stop")

# Check what's running
monitor_process(action="status")
```

**Silent vs react mode:**

| Mode | Behavior | Best for |
|---|---|---|
| `react=false` (default) | Output buffered quietly, check with `read_terminal` | Dev servers, chatty watchers |
| `react=true` | Each output chunk → new LLM turn | Test runners, log monitors, error watching |

**Note:** The monitor spawns an independent child process using the session's cwd and outer environment. It does not inherit PTY shell state (active virtualenvs, `cd`s inside the shell). Prefix with `source .venv/bin/activate &&` when needed. Only one monitor can run at a time.

### `run_in_terminal`

Runs a command in the persistent PTY shell and waits for it to complete (sentinel-based). Returns the full output **and the command's exit code** (`[exit code: N]` in the result, `exitCode` in `details`; a non-zero code marks the tool result as an error). Best for commands that finish — `npm install`, `pytest`, `git status`, etc.

```
run_in_terminal("npm install")
run_in_terminal("pytest tests/", wait_ms=60000)
```

**Background mode** — set `background=true` for long-lived commands (dev servers, watchers). The command runs in the **same persistent shell** (keeping cwd and active virtualenv, unlike `monitor_process` which uses a separate child process) and the tool returns immediately with any early output. Read progress later with `read_terminal`, stop it with `write_terminal("\x03")`; you're notified (and a turn is triggered) when it exits.

```
run_in_terminal("source .venv/bin/activate", )   # state persists...
run_in_terminal("flask run", background=True)     # ...so this dev server has the venv
read_terminal()                                   # check it later
write_terminal("\x03")                            # stop it
```

Only one background command at a time — it holds the shell's foreground, so a second `run_in_terminal` call returns an error until you stop it.

### `write_terminal`

Sends raw text or keypresses to the shell. Use for interactive prompts.

```
write_terminal("yes\n")
write_terminal("\x03")   # Ctrl+C
```

### `read_terminal`

Reads recent output from the terminal buffer (includes monitor output when running).

```
read_terminal(lines=100)
```

## Tool comparison

| | `bash` tool | `run_in_terminal` | `monitor_process` |
|---|---|---|---|
| Shell state | Fresh subshell | Persistent PTY | Own child process |
| Blocking | Yes | Yes (sentinel), or `background=true` | No — background |
| Output delivery | On completion | On completion / read later (bg) | Push (react) or buffer |
| Infinite processes | ❌ timeout only | ✅ `background=true` (in the persistent shell) | ✅ separate process |
| Keeps shell state (cwd/venv) | ❌ | ✅ (incl. background) | ❌ separate process |
| LLM reacts in real-time | ❌ | On exit (bg triggers a turn) | ✅ react mode |
| Best for | Stateless one-offs | Stateful commands; dev servers needing the venv | Watchers, log monitors |

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) installed globally
- `pi-interactive-shell` installed globally (provides `@xterm/headless`)
- Node.js ≥ 18
- macOS or Linux (node-pty requires native compilation)

## Architecture

- **`PtyManager`** — wraps `node-pty`, manages the shell process lifecycle
- **`MonitorManager`** — spawns an independent `child_process` for background monitoring; buffers output and flushes every 750ms (or at 4KB) into the pi conversation via `pi.sendMessage({ triggerTurn: true })` in react mode
- **`XtermBuffer`** — wraps `@xterm/headless` for display only; renders colored lines for the overlay from raw PTY data
- **`SimpleBuffer`** — plain-text append buffer for `read_terminal` and sentinel-based command completion detection in `run_in_terminal`; also receives monitor output so `read_terminal` sees it

The two buffers serve different purposes: xterm is a screen emulator (viewport model) which handles display correctly but can't be used for line-based output capture. `SimpleBuffer` handles the text side reliably.
