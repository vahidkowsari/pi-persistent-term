import { describe, it, expect } from "vitest";
import { SimpleBuffer } from "../extensions/terminal.ts";

describe("SimpleBuffer — basic appends", () => {
  it("starts empty", () => {
    const b = new SimpleBuffer();
    expect(b.hasContent).toBe(false);
    expect(b.lineCount).toBe(1); // seeded with one empty line
    expect(b.getContext()).toBe("");
  });

  it("appends a single line with no trailing newline", () => {
    const b = new SimpleBuffer();
    b.append("hello");
    expect(b.hasContent).toBe(true);
    expect(b.getContext()).toBe("hello");
    expect(b.lineCount).toBe(1);
  });

  it("appends across multiple writes onto the same line", () => {
    const b = new SimpleBuffer();
    b.append("hel");
    b.append("lo");
    expect(b.getContext()).toBe("hello");
    expect(b.lineCount).toBe(1);
  });

  it("splits on newlines into separate lines", () => {
    const b = new SimpleBuffer();
    b.append("a\nb\nc");
    expect(b.getContext()).toBe("a\nb\nc");
    expect(b.lineCount).toBe(3);
  });
});

describe("SimpleBuffer — carriage-return handling", () => {
  it("treats \\r\\n as a plain line ending (no empty-line clobber)", () => {
    const b = new SimpleBuffer();
    b.append("hello\r\nworld\r\n");
    // trailing empty line is trimmed by getContext
    expect(b.getContext()).toBe("hello\nworld");
  });

  it("collapses a mid-line \\r progress redraw to the last segment", () => {
    const b = new SimpleBuffer();
    b.append("loading 10%\rloading 50%\rloading 100%");
    expect(b.getContext()).toBe("loading 100%");
    expect(b.lineCount).toBe(1);
  });

  it("handles a \\r redraw delivered across separate appends", () => {
    const b = new SimpleBuffer();
    b.append("downloading 1MB");
    b.append("\rdownloading 2MB");
    expect(b.getContext()).toBe("downloading 2MB");
    expect(b.lineCount).toBe(1);
  });
});

describe("SimpleBuffer — ANSI / control stripping", () => {
  it("strips SGR color sequences", () => {
    const b = new SimpleBuffer();
    b.append("\x1b[31mred\x1b[0m");
    expect(b.getContext()).toBe("red");
  });

  it("strips OSC sequences (e.g. window-title sets)", () => {
    const b = new SimpleBuffer();
    b.append("\x1b]0;my title\x07done");
    expect(b.getContext()).toBe("done");
  });

  it("strips stray control chars but keeps tabs", () => {
    const b = new SimpleBuffer();
    b.append("a\x07b\tc");
    expect(b.getContext()).toBe("ab\tc");
  });
});

describe("SimpleBuffer — reads and cap", () => {
  it("getContext(n) returns the last n lines", () => {
    const b = new SimpleBuffer();
    b.append("a\nb\nc\nd");
    expect(b.getContext(2)).toBe("c\nd");
  });

  it("getLinesFrom(start) slices from an index", () => {
    const b = new SimpleBuffer();
    b.append("a\nb\nc\nd");
    expect(b.getLinesFrom(2)).toEqual(["c", "d"]);
  });

  it("caps retained lines at 5000", () => {
    const b = new SimpleBuffer();
    b.append(Array.from({ length: 6000 }, (_, i) => `line${i}`).join("\n"));
    expect(b.lineCount).toBe(5000);
  });

  it("clear() resets content and the empty seed line", () => {
    const b = new SimpleBuffer();
    b.append("stuff");
    b.clear();
    expect(b.hasContent).toBe(false);
    expect(b.lineCount).toBe(1);
    expect(b.getContext()).toBe("");
  });
});
