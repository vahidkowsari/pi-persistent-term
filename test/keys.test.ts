import { describe, it, expect } from "vitest";
import { decodeKeyForPty } from "../extensions/terminal.ts";

describe("decodeKeyForPty — Kitty CSI-u control keys", () => {
  it("decodes Ctrl+C to the interrupt byte", () => {
    expect(decodeKeyForPty("\x1b[99;5u")).toBe("\x03");
  });

  it("decodes Ctrl+Q to the close byte", () => {
    expect(decodeKeyForPty("\x1b[113;5u")).toBe("\x11");
  });

  it("decodes Ctrl+I (letter i) to Tab", () => {
    expect(decodeKeyForPty("\x1b[105;5u")).toBe("\t");
  });

  it("maps Ctrl+[ to Escape and Ctrl+Space to NUL", () => {
    expect(decodeKeyForPty("\x1b[91;5u")).toBe("\x1b");
    expect(decodeKeyForPty("\x1b[32;5u")).toBe("\x00");
  });
});

describe("decodeKeyForPty — named keys", () => {
  it("decodes a disambiguated Escape", () => {
    expect(decodeKeyForPty("\x1b[27u")).toBe("\x1b");
  });

  it("decodes Enter, Tab, Shift+Tab, Backspace", () => {
    expect(decodeKeyForPty("\x1b[13u")).toBe("\r");
    expect(decodeKeyForPty("\x1b[9u")).toBe("\t");
    expect(decodeKeyForPty("\x1b[9;2u")).toBe("\x1b[Z");
    expect(decodeKeyForPty("\x1b[127u")).toBe("\x7f");
  });
});

describe("decodeKeyForPty — printable, alt, shifted", () => {
  it("decodes a plain printable codepoint", () => {
    expect(decodeKeyForPty("\x1b[97u")).toBe("a");
  });

  it("prefers the shifted key when Shift is held", () => {
    expect(decodeKeyForPty("\x1b[97:65;2u")).toBe("A");
  });

  it("prefixes Alt-modified keys with ESC", () => {
    expect(decodeKeyForPty("\x1b[97;3u")).toBe("\x1ba");
  });
});

describe("decodeKeyForPty — modifyOtherKeys (tmux fallback)", () => {
  it("decodes Ctrl+C", () => {
    expect(decodeKeyForPty("\x1b[27;5;99~")).toBe("\x03");
  });

  it("decodes Ctrl+Q", () => {
    expect(decodeKeyForPty("\x1b[27;5;113~")).toBe("\x11");
  });
});

describe("decodeKeyForPty — release events and pass-through", () => {
  it("drops Kitty key-release events", () => {
    expect(decodeKeyForPty("\x1b[99;5:3u")).toBe("");
    expect(decodeKeyForPty("\x1b[5;1:3~")).toBe("");
  });

  it("forwards repeat events like presses", () => {
    expect(decodeKeyForPty("\x1b[99;5:2u")).toBe("\x03");
  });

  it("passes plain text through unchanged", () => {
    expect(decodeKeyForPty("ls -la\n")).toBe("ls -la\n");
  });

  it("passes legacy escape sequences (arrows, PgUp/PgDn) through unchanged", () => {
    expect(decodeKeyForPty("\x1b[A")).toBe("\x1b[A");
    expect(decodeKeyForPty("\x1b[5~")).toBe("\x1b[5~");
    expect(decodeKeyForPty("\x1b[6;2~")).toBe("\x1b[6;2~");
  });

  it("passes raw control bytes (no protocol active) through unchanged", () => {
    expect(decodeKeyForPty("\x03")).toBe("\x03");
    expect(decodeKeyForPty("\x11")).toBe("\x11");
  });

  it("does not mistake bracketed paste for a release event", () => {
    const paste = "\x1b[200~99;5:3u\x1b[201~";
    expect(decodeKeyForPty(paste)).toBe(paste);
  });
});
