import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { PtyManager, SimpleBuffer, findSentinelIndex, parseExitCode, extractOutput } from "../extensions/terminal.ts";

// Force a clean POSIX shell for the PTY. The user's interactive $SHELL (zsh
// with autosuggest/syntax-highlight plugins) redraws the input line with
// cursor/ANSI escapes and mangles rapidly-injected commands — non-deterministic
// for tests. PtyManager reads process.env.SHELL at start(), so set it here.
const _origShell = process.env.SHELL;
process.env.SHELL = "/bin/sh";
afterAll(() => {
  if (_origShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = _origShell;
});

// Integration tests that drive a REAL node-pty shell — they exercise the
// parts unit tests can't: the live PTY data flow, the sentinel round-trip
// through actual shell echo, real exit codes, and cross-command state
// persistence (the extension's whole reason to exist).
//
// Skipped automatically if node-pty can't load (e.g. Windows CI without a
// native build), so the suite stays green everywhere.

const probe = new PtyManager();
probe.start(process.cwd(), 80, 24);
const PTY_OK = probe.isRunning;
probe.kill();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn("[pty.integration] node-pty unavailable — skipping live PTY tests");
}

const d = PTY_OK ? describe : describe.skip;

/** Replicates run_in_terminal's sentinel protocol against a live PTY. */
function makeRunner(pty: PtyManager, simple: SimpleBuffer) {
  return async function run(command: string, timeoutMs = 8000) {
    const linesBefore = simple.lineCount;
    const sentinel = `__PI_TEST_${Math.random().toString(36).slice(2, 10)}__`;
    // Single atomic write so the command and its sentinel can't interleave.
    pty.write(`${command}\necho "${sentinel}:$?"\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      const newLines = simple.getLinesFrom(linesBefore);
      const idx = findSentinelIndex(newLines, sentinel);
      if (idx !== -1) {
        const exitCode = parseExitCode(newLines[idx]!);
        const output = newLines
          .slice(0, idx)
          .filter((l) => { const t = l.trim(); return t !== "" && !t.includes(sentinel); })
          .join("\n")
          .trimEnd();
        return { exitCode, output };
      }
    }
    throw new Error(`sentinel never appeared for: ${command}`);
  };
}

d("PtyManager — lifecycle", () => {
  it("starts, exposes a pid, and stops", () => {
    const pty = new PtyManager();
    pty.start(process.cwd(), 80, 24);
    expect(pty.isRunning).toBe(true);
    expect(typeof pty.pid).toBe("number");
    expect(pty.error).toBeNull();
    pty.kill();
    expect(pty.isRunning).toBe(false);
  });

  it("resize does not throw on a live or dead pty", () => {
    const pty = new PtyManager();
    pty.start(process.cwd(), 80, 24);
    expect(() => pty.resize(120, 40)).not.toThrow();
    pty.kill();
    expect(() => pty.resize(100, 30)).not.toThrow();
  });

  it("onData delivers shell output and unsubscribe stops it", async () => {
    const pty = new PtyManager();
    let chunks = 0;
    const unsub = pty.onData(() => { chunks++; });
    pty.start(process.cwd(), 80, 24);
    pty.write("echo hi\n");
    await new Promise((r) => setTimeout(r, 500));
    expect(chunks).toBeGreaterThan(0);
    const seen = chunks;
    unsub();
    pty.write("echo again\n");
    await new Promise((r) => setTimeout(r, 300));
    expect(chunks).toBe(seen); // no more deliveries after unsubscribe
    pty.kill();
  });
});

d("run_in_terminal sentinel protocol — live PTY", () => {
  let pty: PtyManager;
  let simple: SimpleBuffer;
  let run: ReturnType<typeof makeRunner>;

  beforeEach(async () => {
    pty = new PtyManager();
    simple = new SimpleBuffer();
    pty.onData((data) => simple.append(data));
    pty.start(process.cwd(), 80, 24);
    run = makeRunner(pty, simple);
    await new Promise((r) => setTimeout(r, 500)); // let the shell finish init
  });

  afterEach(() => { pty.kill(); });

  it("reports exit code 0 for a successful command", async () => {
    const { exitCode } = await run("true");
    expect(exitCode).toBe(0);
  }, 15000);

  it("reports a non-zero exit code for a failing command", async () => {
    const { exitCode } = await run("false");
    expect(exitCode).toBe(1);
  }, 15000);

  it("reports an arbitrary exit code without killing the shell", async () => {
    const first = await run("(exit 3)"); // subshell so the session survives
    expect(first.exitCode).toBe(3);
    const second = await run("true"); // shell still alive
    expect(second.exitCode).toBe(0);
  }, 15000);

  it("captures command stdout", async () => {
    const { exitCode, output } = await run("echo hello-from-pty");
    expect(exitCode).toBe(0);
    expect(output).toContain("hello-from-pty");
  }, 15000);

  it("persists exported env vars across commands (same shell)", async () => {
    await run("export PI_TEST_VAR=persisted123");
    const { output } = await run("echo $PI_TEST_VAR");
    expect(output).toContain("persisted123");
  }, 15000);

  it("persists cwd changes across commands", async () => {
    await run("cd /");
    const { output } = await run("pwd");
    expect(output.trim()).toBe("/");
  }, 15000);

  // Mirrors what background:true run_in_terminal does: fire the command +
  // sentinel without waiting, then a watcher polls for completion. Verifies the
  // sentinel is absent while the command is still running and resolves with the
  // right exit code + output once it exits.
  it("detects completion of a slow command asynchronously (background mechanism)", async () => {
    const linesBefore = simple.lineCount;
    const sentinel = `__PI_BG_${Math.random().toString(36).slice(2, 8)}__`;
    pty.write(`(sleep 0.4; echo finished)\necho "${sentinel}:$?"\n`);

    await new Promise((r) => setTimeout(r, 100)); // still running
    expect(findSentinelIndex(simple.getLinesFrom(linesBefore), sentinel)).toBe(-1);

    const deadline = Date.now() + 5000;
    let idx = -1;
    while (Date.now() < deadline && idx === -1) {
      await new Promise((r) => setTimeout(r, 50));
      idx = findSentinelIndex(simple.getLinesFrom(linesBefore), sentinel);
    }
    expect(idx).toBeGreaterThan(-1);
    const lines = simple.getLinesFrom(linesBefore);
    expect(parseExitCode(lines[idx]!)).toBe(0);
    expect(extractOutput(lines.slice(0, idx), sentinel)).toContain("finished");
  }, 15000);
});
