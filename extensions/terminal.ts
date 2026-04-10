import { createRequire } from "node:module";
import { platform } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateToWidth } from "@mariozechner/pi-tui";

const _pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _require = createRequire(resolve(_pkgDir, "package.json"));

// @xterm/headless is a direct dependency — resolve from our own node_modules
const _xtermRequire = _require;

// ─── ANSI reconstruction from xterm cells (for colored display) ───────────────

interface CellAttrs {
  fgDefault: boolean; fgRGB: boolean; fgPalette: boolean; fgColor: number;
  bgDefault: boolean; bgRGB: boolean; bgPalette: boolean; bgColor: number;
  bold: boolean; dim: boolean; italic: boolean; underline: boolean;
  inverse: boolean; strikethrough: boolean;
}

function defaultAttrs(): CellAttrs {
  return {
    fgDefault: true, fgRGB: false, fgPalette: false, fgColor: -1,
    bgDefault: true, bgRGB: false, bgPalette: false, bgColor: -1,
    bold: false, dim: false, italic: false, underline: false,
    inverse: false, strikethrough: false,
  };
}

function attrsEqual(a: CellAttrs, b: CellAttrs): boolean {
  return (
    a.fgDefault === b.fgDefault && a.fgRGB === b.fgRGB &&
    a.fgPalette === b.fgPalette && a.fgColor === b.fgColor &&
    a.bgDefault === b.bgDefault && a.bgRGB === b.bgRGB &&
    a.bgPalette === b.bgPalette && a.bgColor === b.bgColor &&
    a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
    a.underline === b.underline && a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough
  );
}

function buildSgr(attrs: CellAttrs): string {
  const codes: number[] = [0];
  if (attrs.bold) codes.push(1);
  if (attrs.dim) codes.push(2);
  if (attrs.italic) codes.push(3);
  if (attrs.underline) codes.push(4);
  if (attrs.inverse) codes.push(7);
  if (attrs.strikethrough) codes.push(9);
  if (!attrs.fgDefault) {
    if (attrs.fgRGB) {
      codes.push(38, 2, (attrs.fgColor >> 16) & 0xff, (attrs.fgColor >> 8) & 0xff, attrs.fgColor & 0xff);
    } else if (attrs.fgPalette) {
      if (attrs.fgColor < 8) codes.push(30 + attrs.fgColor);
      else if (attrs.fgColor < 16) codes.push(90 + (attrs.fgColor - 8));
      else codes.push(38, 5, attrs.fgColor);
    }
  }
  if (!attrs.bgDefault) {
    if (attrs.bgRGB) {
      codes.push(48, 2, (attrs.bgColor >> 16) & 0xff, (attrs.bgColor >> 8) & 0xff, attrs.bgColor & 0xff);
    } else if (attrs.bgPalette) {
      if (attrs.bgColor < 8) codes.push(40 + attrs.bgColor);
      else if (attrs.bgColor < 16) codes.push(100 + (attrs.bgColor - 8));
      else codes.push(48, 5, attrs.bgColor);
    }
  }
  return `\x1b[${codes.join(";")}m`;
}

function lineToAnsi(line: any, cell: any): string {
  let result = "";
  let cur = defaultAttrs();
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell);
    const ch = cell.getChars() || " ";
    if (cell.getWidth() === 0) continue;
    const next: CellAttrs = {
      fgDefault: cell.isFgDefault(), fgRGB: cell.isFgRGB(),
      fgPalette: cell.isFgPalette(), fgColor: cell.getFgColor(),
      bgDefault: cell.isBgDefault(), bgRGB: cell.isBgRGB(),
      bgPalette: cell.isBgPalette(), bgColor: cell.getBgColor(),
      bold: !!cell.isBold(), dim: !!cell.isDim(), italic: !!cell.isItalic(),
      underline: !!cell.isUnderline(), inverse: !!cell.isInverse(),
      strikethrough: !!cell.isStrikethrough(),
    };
    if (!attrsEqual(cur, next)) { result += buildSgr(next); cur = next; }
    result += ch;
  }
  if (!attrsEqual(cur, defaultAttrs())) result += "\x1b[0m";
  return result.trimEnd();
}

// ─── XtermBuffer — display only, wraps @xterm/headless ────────────────────────

class XtermBuffer {
  private term: any;
  private _nullCell: any;

  constructor(cols: number, rows: number) {
    const { Terminal } = _xtermRequire("@xterm/headless");
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this._nullCell = this.term.buffer.active.getNullCell();
  }

  write(data: string): void { this.term.write(data); }

  resize(cols: number, rows: number): void {
    try { this.term.resize(cols, rows); } catch {}
  }

  clear(): void { this.term.clear(); }

  /** Lines from `start` to `end` rendered with ANSI colors, for the overlay */
  getDisplayLines(start: number, end: number): string[] {
    const buf = this.term.buffer.active;
    const result: string[] = [];
    for (let i = start; i < end && i < buf.length; i++) {
      const line = buf.getLine(i);
      result.push(line ? lineToAnsi(line, this._nullCell) : "");
    }
    return result;
  }

  get lineCount(): number { return this.term.buffer.active.length; }
}

// ─── SimpleBuffer — plain-text line buffer for read_terminal / run_in_terminal ─
//
// xterm is a screen emulator (viewport + scrollback). Its buffer doesn't grow
// line-by-line for small output — new lines overwrite existing viewport rows.
// This simple append buffer handles sentinel detection and LLM context reliably.

class SimpleBuffer {
  private lines: string[] = [""];
  private _hasContent = false;

  append(rawData: string): void {
    this._hasContent = true;

    // Strip all ANSI/control sequences — we only need plain text here
    const text = rawData
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b./g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      let chunk = parts[i]!;
      // Strip trailing \r from \r\n line endings before CR overwrite check.
      // Without this, "hello\r" splits into ["hello", ""] and the empty last
      // segment overwrites the line content with an empty string.
      if (chunk.endsWith("\r")) chunk = chunk.slice(0, -1);
      // Mid-line \r: readline redraws the current line (last segment wins)
      if (chunk.includes("\r")) {
        const crParts = chunk.split("\r");
        chunk = crParts[crParts.length - 1]!;
        this.lines[this.lines.length - 1] = chunk;
      } else if (i === 0) {
        this.lines[this.lines.length - 1] += chunk;
      } else {
        this.lines.push(chunk);
      }
    }

    if (this.lines.length > 5000) this.lines = this.lines.slice(-5000);
  }

  get hasContent(): boolean { return this._hasContent; }
  get lineCount(): number { return this.lines.length; }

  getLinesFrom(start: number): string[] { return this.lines.slice(start); }

  getContext(n = 100): string {
    return this.lines.slice(-n).join("\n").trimEnd();
  }

  clear(): void {
    this.lines = [""];
    this._hasContent = false;
  }
}

// ─── Monitor Manager ─────────────────────────────────────────────────────────
//
// Spawns a child process independently of the PTY and streams its stdout/stderr
// into the pi conversation. In react mode each flush triggers a new LLM turn so
// Claude can respond to output in real-time without polling.

type MonitorFlushCallback = (output: string, exited: boolean, exitCode?: number | null) => void;

class MonitorManager {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _command = "";
  private _react = false;
  private _onFlush: MonitorFlushCallback;

  get isRunning(): boolean { return this.proc !== null; }
  get command(): string { return this._command; }
  get react(): boolean { return this._react; }

  constructor(onFlush: MonitorFlushCallback) { this._onFlush = onFlush; }

  start(command: string, cwd: string, react: boolean): void {
    this._command = command;
    this._react = react;
    this.buffer = "";

    const shell = process.env.SHELL ?? (platform() === "win32" ? "cmd.exe" : "/bin/bash");
    this.proc = spawn(shell, ["-c", command], {
      cwd,
      env: process.env as Record<string, string>,
    });

    const onData = (data: Buffer) => {
      this.buffer += data.toString();
      if (this.buffer.length >= 4096) this.doFlush(false);
    };
    this.proc.stdout?.on("data", onData);
    this.proc.stderr?.on("data", onData);

    this.proc.on("close", (code: number | null) => {
      if (!this.proc) return; // already stopped via stop()
      if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
      this.proc = null;
      this.doFlush(true, code);
      this._command = "";
    });

    this.proc.on("error", (err: Error) => {
      if (!this.proc) return;
      this.buffer += `[monitor error: ${err.message}]`;
      if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
      this.proc = null;
      this.doFlush(true, -1);
      this._command = "";
    });

    this.flushTimer = setInterval(() => this.doFlush(false), 750);
  }

  private doFlush(exited: boolean, exitCode?: number | null): void {
    const content = this.buffer;
    this.buffer = "";
    if (content || exited) this._onFlush(content, exited, exitCode);
  }

  // Returns the command that was running. Nulls proc before kill so the exit
  // handler's guard prevents a double-flush.
  stop(): string {
    const cmd = this._command;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    const proc = this.proc;
    this.proc = null;
    this._command = "";
    this._react = false;  // prevent react flush triggering a turn on explicit stop
    // flush remaining buffer (not as exited — caller handles the notification)
    const content = this.buffer;
    this.buffer = "";
    if (content) this._onFlush(content, false);
    try { proc?.kill(); } catch {}
    return cmd;
  }
}

// ─── PTY Manager ──────────────────────────────────────────────────────────────

type DataListener = (data: string) => void;
type ExitListener = () => void;

class PtyManager {
  private pty: any = null;
  private dataListeners: DataListener[] = [];
  private exitListeners: ExitListener[] = [];
  private _error: string | null = null;

  get isRunning(): boolean { return this.pty !== null; }
  get error(): string | null { return this._error; }
  get pid(): number | null { return this.pty?.pid ?? null; }

  clearError(): void { this._error = null; }

  start(cwd: string, cols: number, rows: number): void {
    if (this.pty) return;
    try {
      const nodePty = _require("node-pty");
      const shell = process.env.SHELL ?? (platform() === "win32" ? "cmd.exe" : "/bin/bash");
      this.pty = nodePty.spawn(shell, [], {
        name: "xterm-256color", cols, rows, cwd,
        env: process.env as Record<string, string>,
      });
      this.pty.onData((data: string) => { for (const l of this.dataListeners) l(data); });
      this.pty.onExit(() => { this.pty = null; for (const l of this.exitListeners) l(); });
      this._error = null;
    } catch (e: any) {
      this._error = String(e?.message ?? e);
    }
  }

  write(data: string): void { this.pty?.write(data); }

  resize(cols: number, rows: number): void {
    try { this.pty?.resize(cols, rows); } catch {}
  }

  kill(): void {
    try { this.pty?.kill(); } catch {}
    this.pty = null;
  }

  onData(cb: DataListener): () => void {
    this.dataListeners.push(cb);
    return () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); };
  }

  onExit(cb: ExitListener): () => void {
    this.exitListeners.push(cb);
    return () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb); };
  }
}

// ─── Terminal TUI Component ────────────────────────────────────────────────────

const HEADER_LINES = 2;
const FOOTER_LINES = 2;

class TerminalComponent {
  private scrollOffset = 0;
  private requestRenderFn: (() => void) | null = null;

  constructor(
    private xterm: XtermBuffer,
    private pty: PtyManager,
    private onClose: (result?: unknown) => void,
    private theme: any,
  ) {}

  private get visibleLines(): number {
    const rows = process.stdout.rows ?? 40;
    return Math.max(5, Math.floor(rows * 0.55) - HEADER_LINES - FOOTER_LINES);
  }

  setRenderFn(fn: () => void): void { this.requestRenderFn = fn; }
  onNewData(): void { this.requestRenderFn?.(); }

  handleInput(data: string): void {
    if (data === "\x11") { setTimeout(() => this.onClose(), 0); return; }

    const vl = this.visibleLines;
    const maxScroll = Math.max(0, this.xterm.lineCount - vl);

    if (data === "\x1b[5~") { this.scrollOffset = Math.min(this.scrollOffset + vl, maxScroll); this.requestRenderFn?.(); return; }
    if (data === "\x1b[6~") { this.scrollOffset = Math.max(0, this.scrollOffset - vl); this.requestRenderFn?.(); return; }
    if (data === "\x1b[5;2~") { this.scrollOffset = Math.min(this.scrollOffset + 5, maxScroll); this.requestRenderFn?.(); return; }
    if (data === "\x1b[6;2~") { this.scrollOffset = Math.max(0, this.scrollOffset - 5); this.requestRenderFn?.(); return; }

    this.scrollOffset = 0;
    this.pty.write(data);
    this.requestRenderFn?.();
  }

  render(width: number): string[] {
    const t = this.theme;
    const border = t.fg("border", "─".repeat(width));
    const statusText = this.pty.isRunning
      ? t.fg("success", "● running") + (this.pty.pid ? t.fg("dim", ` pid:${this.pty.pid}`) : "")
      : this.pty.error
      ? t.fg("error", "● error: " + this.pty.error.slice(0, 40))
      : t.fg("error", "● stopped");
    const scrollText = this.scrollOffset > 0
      ? t.fg("warning", ` ↑ scrolled ${this.scrollOffset} lines (PgDn to return)`)
      : "";

    const vl = this.visibleLines;
    const totalLines = this.xterm.lineCount;
    const endIdx = totalLines - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - vl);
    const visible = this.xterm.getDisplayLines(startIdx, endIdx);
    while (visible.length < vl) visible.unshift("");

    const lines: string[] = [];
    lines.push(border);
    lines.push(truncateToWidth(` ${t.fg("accent", t.bold("Terminal"))}  ${statusText}${scrollText}`, width));
    for (const line of visible) lines.push(truncateToWidth(line, width));
    lines.push(border);
    lines.push(truncateToWidth(
      t.fg("dim", " Ctrl+Q") + " back to pi  " +
      t.fg("dim", "PgUp/PgDn") + " scroll  " +
      t.fg("dim", "Ctrl+C") + " interrupt",
      width,
    ));
    return lines;
  }

  invalidate(): void {}
}

// ─── Extension Entry Point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let xterm: XtermBuffer | null = null;
  const simple = new SimpleBuffer();
  const pty = new PtyManager();
  let autoInjectContext = true;
  let activeComponent: TerminalComponent | null = null;
  let overlayOpen = false;
  let overlayDone: ((result?: unknown) => void) | null = null;
  let sessionCwd = process.cwd();
  let sessionCtx: any = null; // captured for use in async monitor callbacks
  let unsubData: (() => void) | null = null;
  let unsubExit: (() => void) | null = null;

  // Monitor — flush callback runs outside any event handler so we use sessionCtx
  const monitor = new MonitorManager((output, exited, exitCode) => {
    if (output) simple.append(output);

    if (exited) {
      const note = exitCode === 0
        ? "[monitor: process exited cleanly (code 0)]"
        : `[monitor: process exited with code ${exitCode ?? "unknown"}]`;
      simple.append("\n" + note);
      const level = exitCode === 0 ? "info" : "warning";
      sessionCtx?.ui.notify(`Monitor: ${note}`, level);
      if (sessionCtx) updateStatus(sessionCtx);

      if (monitor.react) {
        pi.sendMessage({
          customType: "monitor-output",
          content: (output ? output + "\n" : "") + note,
          display: true,
          details: { command: monitor.command, exited: true, exitCode },
        }, { triggerTurn: true });
      }
      return;
    }

    if (output && monitor.react) {
      pi.sendMessage({
        customType: "monitor-output",
        content: output,
        display: true,
        details: { command: monitor.command, exited: false },
      }, { triggerTurn: true });
    }
  });

  function getTermCols(): number { return Math.max(80, (process.stdout.columns ?? 120) - 2); }
  function getTermRows(): number { return Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.55) - 4); }

  function ensurePty(): boolean {
    if (pty.isRunning) return true;
    if (pty.error) return false; // sticky until /term-restart
    const cols = getTermCols();
    const rows = getTermRows();
    if (!xterm) xterm = new XtermBuffer(cols, rows);
    pty.start(sessionCwd, cols, rows);
    return pty.isRunning;
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    sessionCtx = ctx;

    unsubData?.();
    unsubExit?.();

    unsubData = pty.onData((data) => {
      xterm?.write(data);
      simple.append(data);
      activeComponent?.onNewData();
    });

    unsubExit = pty.onExit(() => {
      ctx.ui.notify("Terminal: shell process exited", "warning");
      // Close the overlay if open so user isn't stuck with a dead shell
      if (overlayOpen && overlayDone) {
        overlayDone();
      } else {
        activeComponent?.onNewData();
      }
    });

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubData?.();
    unsubExit?.();
    unsubData = null;
    unsubExit = null;
    pty.kill();
    if (monitor.isRunning) monitor.stop();
  });

  function updateStatus(ctx: any) {
    let status: string;
    if (pty.error) {
      status = "\x1b[31m⬛ term\x1b[0m";
    } else {
      const ctxOff = autoInjectContext ? "" : " \x1b[2m(ctx off)\x1b[0m";
      status = `\x1b[32m⬛ term\x1b[0m${ctxOff}`;
    }
    if (monitor.isRunning) {
      const cmd = monitor.command.length > 24 ? monitor.command.slice(0, 24) + "…" : monitor.command;
      const reactBadge = monitor.react ? " \x1b[33m⚡react\x1b[0m" : "";
      status += ` \x1b[33m●\x1b[0m \x1b[2m${cmd}\x1b[0m${reactBadge}`;
    }
    ctx.ui.setStatus("pi-persistent-term", status);
  }

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!autoInjectContext || !simple.hasContent) return;
    const context = simple.getContext(80);
    if (!context) return;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n<terminal_context>\nRecent terminal output (last ~80 lines):\n\`\`\`\n${context}\n\`\`\`\n</terminal_context>`,
    };
  });

  pi.registerCommand("term", {
    description: "Open terminal panel — Ctrl+Q to return to pi",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("Terminal requires interactive mode", "error"); return; }
      if (overlayOpen) { ctx.ui.notify("Terminal is already open — press Ctrl+Q to close it", "info"); return; }
      if (!ensurePty()) {
        ctx.ui.notify(`Terminal unavailable: ${pty.error}`, "error");
        ctx.ui.notify("Run /term-restart to retry, or check that node-pty is installed", "info");
        return;
      }

      overlayOpen = true;
      try {
        await ctx.ui.custom(
          (tui, theme, _kb, done) => {
            overlayDone = done;
            const component = new TerminalComponent(xterm!, pty, done, theme);
            activeComponent = component;
            component.setRenderFn(() => tui.requestRender());
            return {
              render: (w: number) => component.render(w),
              handleInput: (data: string) => { component.handleInput(data); },
              invalidate: () => component.invalidate(),
            };
          },
          {
            overlay: true,
            overlayOptions: { anchor: "bottom-center" as any, width: "100%", maxHeight: "55%" },
          },
        );
      } finally {
        overlayOpen = false;
        overlayDone = null;
        activeComponent = null;
      }
    },
  });

  pi.registerCommand("term-clear", {
    description: "Clear the terminal buffer",
    handler: async (_args, ctx) => {
      xterm?.clear();
      simple.clear();
      ctx.ui.notify("Terminal buffer cleared", "info");
    },
  });

  pi.registerCommand("term-restart", {
    description: "Restart the terminal shell process",
    handler: async (_args, ctx) => {
      if (overlayOpen) {
        ctx.ui.notify("Close the terminal overlay first (Ctrl+Q)", "warning");
        return;
      }
      pty.kill();
      pty.clearError();
      if (ensurePty()) {
        ctx.ui.notify("Terminal restarted", "info");
      } else {
        ctx.ui.notify(`Terminal failed to start: ${pty.error}`, "error");
      }
      updateStatus(ctx);
    },
  });

  pi.registerCommand("term-context", {
    description: "Toggle auto-injecting terminal output into LLM context",
    handler: async (_args, ctx) => {
      autoInjectContext = !autoInjectContext;
      ctx.ui.notify(`Terminal context injection: ${autoInjectContext ? "ON ✓" : "OFF"}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("monitor-stop", {
    description: "Stop the currently monitored background process",
    handler: async (_args, ctx) => {
      if (!monitor.isRunning) {
        ctx.ui.notify("No monitor is running", "info");
        return;
      }
      const cmd = monitor.stop();
      updateStatus(ctx);
      ctx.ui.notify(`Monitor stopped: ${cmd}`, "info");
    },
  });

  pi.registerShortcut("ctrl+`", {
    description: "Open terminal panel",
    handler: async (_ctx) => { pi.sendUserMessage("/term", { deliverAs: "followUp" }); },
  });

  pi.registerTool({
    name: "monitor_process",
    label: "Monitor Process",
    description:
      "Start or stop background monitoring of a shell command's stdout/stderr. " +
      "In react mode (react=true) each chunk of output is pushed into the conversation " +
      "and triggers a new LLM turn so you can respond in real-time — no polling needed. " +
      "In silent mode (react=false, default) output is buffered quietly and readable via read_terminal. " +
      "Only one monitor can run at a time. Use action='stop' to kill it.",
    promptSnippet: "Monitor a long-running process; optionally react to output in real-time",
    parameters: Type.Object({
      action: StringEnum(["start", "stop", "status"] as const, { description: '"start" | "stop" | "status"' }),
      command: Type.Optional(Type.String({ description: "Shell command to monitor (required for start)" })),
      react: Type.Optional(Type.Boolean({ description: "Push output into conversation and trigger LLM turns in real-time (default: false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "status") {
        if (!monitor.isRunning) {
          return { content: [{ type: "text" as const, text: "No monitor running." }], details: {} };
        }
        return {
          content: [{ type: "text" as const, text: `Monitoring: ${monitor.command}\nMode: ${monitor.react ? "react (triggers LLM turns)" : "silent (buffered)"}` }],
          details: { command: monitor.command, react: monitor.react },
        };
      }

      if (params.action === "stop") {
        if (!monitor.isRunning) {
          return { content: [{ type: "text" as const, text: "No monitor is running." }], details: {} };
        }
        const cmd = monitor.stop();
        updateStatus(ctx);
        return { content: [{ type: "text" as const, text: `Stopped monitoring: ${cmd}` }], details: { command: cmd } };
      }

      // action === "start"
      if (!params.command?.trim()) {
        throw new Error('"command" is required for action=start');
      }
      if (monitor.isRunning) {
        throw new Error(`Already monitoring: "${monitor.command}" — stop it first with action="stop"`);
      }

      monitor.start(params.command, sessionCwd, params.react ?? false);
      updateStatus(ctx);

      const mode = params.react
        ? "react mode — output will be pushed into the conversation and trigger new turns"
        : "silent mode — output is buffered, use read_terminal to check or set react=true";
      return {
        content: [{ type: "text" as const, text: `Monitoring started: ${params.command}\n${mode}` }],
        details: { command: params.command, react: params.react ?? false },
      };
    },
  });

  pi.registerTool({
    name: "read_terminal",
    label: "Read Terminal",
    description:
      "Read recent output from the integrated terminal shell session. " +
      "Use this to see logs, command output, errors, or anything printed to the terminal.",
    promptSnippet: "Read recent terminal output",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "Number of recent lines to read (default: 100, max: 500)" })),
    }),
    async execute(_id, params) {
      const n = Math.min(params.lines ?? 100, 500);
      const context = simple.getContext(n);
      return {
        content: [{ type: "text" as const, text: context || "(terminal buffer is empty — nothing has been run yet)" }],
        details: { totalLines: simple.lineCount, returned: n },
      };
    },
  });

  pi.registerTool({
    name: "write_terminal",
    label: "Write to Terminal",
    description:
      "Send text to the terminal. Append \\n to execute as a command. " +
      "Use this to send input to a running process. " +
      "Pass an actual newline character or the literal string '\\\\n' — both are accepted. " +
      "For control sequences, pass the actual byte (e.g., the Ctrl+C character) or its literal form '\\\\x03'.",
    promptSnippet: "Send text or keypresses to the terminal",
    parameters: Type.Object({
      text: Type.String({ description: 'Text to send. Examples: "yes\\n" to confirm a prompt, "\\x03" for Ctrl+C.' }),
    }),
    async execute(_id, params) {
      if (!ensurePty()) {
        return {
          content: [{ type: "text" as const, text: pty.error ? `Terminal failed to start: ${pty.error}` : "Terminal shell is not running" }],
          details: {}, isError: true,
        };
      }
      const text = params.text
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      pty.write(text);
      await new Promise((r) => setTimeout(r, 400));
      const recent = simple.getContext(20);
      return {
        content: [{ type: "text" as const, text: `Sent. Recent terminal output:\n${recent}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "run_in_terminal",
    label: "Run in Terminal",
    description:
      "Run a shell command in the integrated terminal and capture its output. " +
      "Unlike the bash tool, this runs in the user's persistent shell session " +
      "(same environment, history, active virtualenvs, etc.).",
    promptSnippet: "Run a command in the user's terminal and get output",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      wait_ms: Type.Optional(Type.Number({ description: "Maximum milliseconds to wait for the command to finish (default: 15000)." })),
    }),
    async execute(_id, params, _signal, onUpdate) {
      if (!ensurePty()) {
        return {
          content: [{ type: "text" as const, text: pty.error ? `Terminal failed to start: ${pty.error}` : "Terminal shell is not running" }],
          details: {}, isError: true,
        };
      }

      const linesBefore = simple.lineCount;
      const sentinel = `__PI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;

      // Show the command immediately before any output arrives
      onUpdate?.({ content: [{ type: "text" as const, text: `$ ${params.command}` }], details: undefined });

      pty.write(params.command + "\n");
      pty.write(`echo '${sentinel}'\n`);

      const maxWaitMs = params.wait_ms ?? 15_000;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        const newLines = simple.getLinesFrom(linesBefore);
        const sentinelIdx = newLines.findIndex((l) => l.trim() === sentinel);

        // Stream live output while waiting for sentinel
        if (onUpdate) {
          const liveLines = newLines
            .slice(0, sentinelIdx === -1 ? undefined : sentinelIdx)
            .filter((l) => { const t = l.trim(); return t !== "" && !t.includes(sentinel); });
          onUpdate({
            content: [{ type: "text" as const, text: `$ ${params.command}\n${liveLines.join("\n")}` }],
            details: undefined,
          });
        }

        if (sentinelIdx !== -1) {
          const output = newLines
            .slice(0, sentinelIdx)
            .filter((l) => { const t = l.trim(); return t !== "" && !t.includes(sentinel); })
            .join("\n")
            .trimEnd();
          return {
            content: [{ type: "text" as const, text: `$ ${params.command}\n${output || "(no output)"}` }],
            details: { linesAdded: newLines.length, completed: true },
          };
        }
      }

      const newLines = simple.getLinesFrom(linesBefore);
      const output = newLines.join("\n").trimEnd();
      return {
        content: [{ type: "text" as const, text: `$ ${params.command}\n${output || "(no output within timeout — command may still be running)"}` }],
        details: { timedOut: true, waitMs: maxWaitMs },
      };
    },
  });
}
