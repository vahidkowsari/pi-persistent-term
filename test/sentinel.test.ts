import { describe, it, expect } from "vitest";
import { findSentinelIndex, parseExitCode, formatExitStatus } from "../extensions/terminal.ts";

const SENT = "__PI_DONE_1700000000000_abc123__";

describe("findSentinelIndex", () => {
  it("matches the sentinel output line, not the echoed command", () => {
    const lines = [
      "hello",
      `echo "${SENT}:$?"`, // echoed command (PTY local echo) — must be ignored
      `${SENT}:0`,         // actual output line
    ];
    expect(findSentinelIndex(lines, SENT)).toBe(2);
  });

  it("tolerates leading/trailing whitespace on the output line", () => {
    expect(findSentinelIndex(["x", `  ${SENT}:3  `], SENT)).toBe(1);
  });

  it("returns -1 when the sentinel has not arrived yet", () => {
    expect(findSentinelIndex(["building...", "still going"], SENT)).toBe(-1);
  });
});

describe("parseExitCode", () => {
  it("parses a success code", () => {
    expect(parseExitCode(`${SENT}:0`)).toBe(0);
  });

  it("parses a non-zero code", () => {
    expect(parseExitCode(`${SENT}:3`)).toBe(3);
  });

  it("parses common signal-derived codes", () => {
    expect(parseExitCode(`${SENT}:130`)).toBe(130); // Ctrl+C
  });

  it("ignores surrounding whitespace", () => {
    expect(parseExitCode(`  ${SENT}:42  `)).toBe(42);
  });

  it("returns null when no code is present", () => {
    expect(parseExitCode(SENT)).toBeNull();
    expect(parseExitCode("not a sentinel line")).toBeNull();
  });
});

describe("formatExitStatus", () => {
  it("renders zero and non-zero codes", () => {
    expect(formatExitStatus(0)).toBe("\n[exit code: 0]");
    expect(formatExitStatus(1)).toBe("\n[exit code: 1]");
  });

  it("renders nothing when the code is unknown", () => {
    expect(formatExitStatus(null)).toBe("");
  });
});
