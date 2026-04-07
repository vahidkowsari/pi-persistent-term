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
git clone https://github.com/kowsari/pi-persistent-term
cd pi-persistent-term
npm install
pi install .
```

## Commands

| Command | Description |
|---|---|
| `/term` | Open terminal overlay |
| `/term-clear` | Clear the terminal buffer |
| `/term-context` | Toggle auto-injecting terminal output into LLM prompts |
| `Ctrl+\`` | Shortcut to open terminal overlay |

## Keybindings (inside overlay)

| Key | Action |
|---|---|
| `Ctrl+Q` | Close overlay, return to pi |
| `Ctrl+C` | Interrupt running process |
| `PgUp` / `PgDn` | Scroll by page |
| `Shift+PgUp` / `Shift+PgDn` | Scroll by 5 lines |

## LLM Tools

### `run_in_terminal`

Runs a command and waits for it to complete. Returns the output.

```
run_in_terminal("npm install")
run_in_terminal("pytest tests/", wait_ms=60000)
```

### `write_terminal`

Sends raw text or keypresses to the shell. Use for interactive prompts.

```
write_terminal("yes\n")
write_terminal("\x03")   # Ctrl+C
```

### `read_terminal`

Reads recent output from the terminal buffer.

```
read_terminal(lines=100)
```

## How it differs from the built-in `bash` tool

| | `bash` tool | `run_in_terminal` |
|---|---|---|
| Shell state | Fresh subshell each call | Persistent across calls |
| `cd` | Lost after call | Persists |
| virtualenvs | Lost after call | Persist |
| Background processes | Not possible | Supported via `write_terminal` |
| Use case | Stateless one-off commands | Stateful workflows |

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) installed globally
- `pi-interactive-shell` installed globally (provides `@xterm/headless`)
- Node.js ≥ 18
- macOS or Linux (node-pty requires native compilation)

## Architecture

- **`PtyManager`** — wraps `node-pty`, manages the shell process lifecycle
- **`XtermBuffer`** — wraps `@xterm/headless` for display only; renders colored lines for the overlay from raw PTY data
- **`SimpleBuffer`** — plain-text append buffer for `read_terminal` and sentinel-based command completion detection in `run_in_terminal`

The two buffers serve different purposes: xterm is a screen emulator (viewport model) which handles display correctly but can't be used for line-based output capture. `SimpleBuffer` handles the text side reliably.
