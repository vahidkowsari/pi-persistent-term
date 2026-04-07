import { createRequire } from "node:module";
import { platform } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth } from "@mariozechner/pi-tui";

const _pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _require = createRequire(resolve(_pkgDir, "package.json"));

// Resolve @xterm/headless from pi-interactive-shell since it's not in our deps
const _xtermRequire = createRequire(
  resolve("/opt/homebrew/lib/node_modules/pi-interactive-shell", "package.json"),
);

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
  let unsubData: (() => void) | null = null;
  let unsubExit: (() => void) | null = null;

  function getTermCols(): number { return Math.max(80, (process.stdout.columns ?? 120) - 2); }
  function getTermRows(): number { return Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.55) - 4); }

  function ensurePty(): boolean {
    if (pty.isRunning) return true;
    if (pty.error) return false;
    const cols = getTermCols();
    const rows = getTermRows();
    if (!xterm) xterm = new XtermBuffer(cols, rows);
    pty.start(sessionCwd, cols, rows);
    return pty.isRunning;
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;

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
  });

  function updateStatus(ctx: any) {
    if (pty.error) {
      ctx.ui.setStatus("pi-terminal", "\x1b[31m⬛ term\x1b[0m");
    } else {
      const ctxOff = autoInjectContext ? "" : " \x1b[2m(ctx off)\x1b[0m";
      ctx.ui.setStatus("pi-terminal", `\x1b[32m⬛ term\x1b[0m${ctxOff}`);
    }
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
        ctx.ui.notify("Run: cd ~/workspace/kowsari/pi-terminal && npm install", "info");
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

  pi.registerCommand("term-context", {
    description: "Toggle auto-injecting terminal output into LLM context",
    handler: async (_args, ctx) => {
      autoInjectContext = !autoInjectContext;
      ctx.ui.notify(`Terminal context injection: ${autoInjectContext ? "ON ✓" : "OFF"}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerShortcut("ctrl+`", {
    description: "Open terminal panel",
    handler: async (_ctx) => { pi.sendUserMessage("/term", { deliverAs: "followUp" }); },
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
    async execute(_id, params) {
      if (!ensurePty()) {
        return {
          content: [{ type: "text" as const, text: pty.error ? `Terminal failed to start: ${pty.error}` : "Terminal shell is not running" }],
          details: {}, isError: true,
        };
      }

      const linesBefore = simple.lineCount;
      const sentinel = `__PI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;

      pty.write(params.command + "\n");
      pty.write(`echo '${sentinel}'\n`);

      const maxWaitMs = params.wait_ms ?? 15_000;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        const newLines = simple.getLinesFrom(linesBefore);
        const sentinelIdx = newLines.findIndex((l) => l.trim() === sentinel);
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
