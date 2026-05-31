import { describe, it, expect } from "vitest";
import { defaultAttrs, attrsEqual, buildSgr } from "../extensions/terminal.ts";

describe("attrsEqual", () => {
  it("two default attrs are equal", () => {
    expect(attrsEqual(defaultAttrs(), defaultAttrs())).toBe(true);
  });

  it("differing flags are not equal", () => {
    expect(attrsEqual(defaultAttrs(), { ...defaultAttrs(), bold: true })).toBe(false);
  });

  it("differing colors are not equal", () => {
    const a = { ...defaultAttrs(), fgDefault: false, fgPalette: true, fgColor: 1 };
    const b = { ...defaultAttrs(), fgDefault: false, fgPalette: true, fgColor: 2 };
    expect(attrsEqual(a, b)).toBe(false);
  });
});

describe("buildSgr", () => {
  it("renders a bare reset for default attrs", () => {
    expect(buildSgr(defaultAttrs())).toBe("\x1b[0m");
  });

  it("encodes style flags", () => {
    expect(buildSgr({ ...defaultAttrs(), bold: true, italic: true })).toBe("\x1b[0;1;3m");
  });

  it("encodes a standard palette foreground (0-7 -> 30-37)", () => {
    expect(buildSgr({ ...defaultAttrs(), fgDefault: false, fgPalette: true, fgColor: 1 })).toBe("\x1b[0;31m");
  });

  it("encodes a bright palette foreground (8-15 -> 90-97)", () => {
    expect(buildSgr({ ...defaultAttrs(), fgDefault: false, fgPalette: true, fgColor: 9 })).toBe("\x1b[0;91m");
  });

  it("encodes a 256-color palette foreground (>=16 -> 38;5;n)", () => {
    expect(buildSgr({ ...defaultAttrs(), fgDefault: false, fgPalette: true, fgColor: 200 })).toBe("\x1b[0;38;5;200m");
  });

  it("encodes a truecolor RGB foreground (38;2;r;g;b)", () => {
    expect(buildSgr({ ...defaultAttrs(), fgDefault: false, fgRGB: true, fgColor: 0xff8800 })).toBe(
      "\x1b[0;38;2;255;136;0m",
    );
  });

  it("encodes a standard palette background (0-7 -> 40-47)", () => {
    expect(buildSgr({ ...defaultAttrs(), bgDefault: false, bgPalette: true, bgColor: 4 })).toBe("\x1b[0;44m");
  });

  it("combines a flag with fg and bg colors", () => {
    const attrs = {
      ...defaultAttrs(),
      bold: true,
      fgDefault: false,
      fgPalette: true,
      fgColor: 2,
      bgDefault: false,
      bgPalette: true,
      bgColor: 0,
    };
    expect(buildSgr(attrs)).toBe("\x1b[0;1;32;40m");
  });
});
