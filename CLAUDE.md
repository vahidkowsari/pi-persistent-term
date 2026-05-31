# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that adds a persistent PTY shell, a colored terminal overlay, and four LLM tools (`run_in_terminal`, `write_terminal`, `read_terminal`, `monitor_process`) to pi. See `README.md` for user-facing docs.

## Layout

- `extensions/terminal.ts` — the entire extension. Everything lives here.
- `package.json` — declares the extension entry point via the `pi.extensions` field.
- No `src/`, no build output, no test suite.

## Build / run

- **No bundler/emit step.** pi loads `extensions/terminal.ts` directly (TypeScript via the host's loader). The "build" is a type-check only — `npm run typecheck` (`tsc --noEmit`). Do not add a bundler or compile-to-JS step unless asked.
- **Tests** run with Vitest: `npm test` (or `npm run test:watch`). `npm run check` does typecheck + tests. Tests cover the *pure* helpers (e.g. the `run_in_terminal` sentinel/exit-code parsing in `extensions/terminal.ts`); anything needing a live PTY/`node-pty` shell still can't be unit-tested — verify those by running pi (`pi install .` then exercise the tools) and say so explicitly rather than claiming verification you don't have.
- When adding logic worth testing, extract it as a small **exported pure function** in `terminal.ts` (keeps the single-file convention) and add cases under `test/`.
- `postinstall` rebuilds `node-pty` from source if the prebuilt binary fails to load. Leave this alone unless debugging install issues.

## Architecture notes (the non-obvious bits)

The extension keeps **two buffers** for terminal output, on purpose:

- `XtermBuffer` (wraps `@xterm/headless`) — viewport/screen emulator. Used only for the colored overlay display. Cannot be relied on for line-by-line capture because new lines overwrite viewport rows.
- `SimpleBuffer` — plain-text append buffer. Used by `read_terminal`, `run_in_terminal` sentinel detection, the LLM context injection, and to mirror `MonitorManager` output. Strips ANSI on the way in.

When changing how terminal data is captured or read, update **both** paths (PTY `onData` → `xterm.write` + `simple.append`) consistently. Don't try to unify them — they exist because each does the other's job badly.

`MonitorManager` runs a **separate** `child_process` (not the PTY). It does not inherit the PTY shell's state (cwd changes inside the shell, active virtualenvs). It uses `sessionCwd` and `process.env`.

`run_in_terminal` uses a sentinel echo (`__PI_DONE_…__`) to detect command completion, since the PTY has no exit-code signal.

Peer deps (`@mariozechner/pi-coding-agent`, `pi-ai`, `pi-tui`, `@sinclair/typebox`) are provided by the host pi install. Don't move them into `dependencies`.

## Conventions

- Match the existing terse style in `terminal.ts` — short comments only where the WHY isn't obvious (look at the existing CR-handling and double-flush-guard comments for the bar).
- Keep everything in `extensions/terminal.ts` unless there's a strong reason to split. Single-file is intentional.
- Don't add abstractions for hypothetical future tools/buffers.

## Releases

- Bump `version` in `package.json` and commit. Recent history (`a06065c`, `f80ec23`) shows the pattern: feature commits followed by a `chore: bump version` commit.
