import { describe, expect, it } from "vitest";
import { formatBytes, humanizeElapsed } from "./format";

describe("formatBytes", () => {
  it("steps through units at 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(2 * 1024 ** 6)).toBe("2048.0 PB");
  });

  it("shows nothing for a missing or impossible size", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
  });
});

describe("humanizeElapsed", () => {
  // The UI's source language (Korean) is the default with no saved choice.
  it("reads milliseconds, seconds, minutes and hours", () => {
    expect(humanizeElapsed(12.4)).toBe("12ms");
    expect(humanizeElapsed(1500)).toBe("1.5초");
    expect(humanizeElapsed(60_000)).toBe("1분");
    expect(humanizeElapsed(61_400)).toBe("1분 1초");
    expect(humanizeElapsed(3_600_000)).toBe("1시간");
    expect(humanizeElapsed(3_660_000)).toBe("1시간 1분");
  });

  it("picks the unit after rounding: no 1000ms or 60.0 seconds", () => {
    expect(humanizeElapsed(999.6)).toBe("1.0초");
    expect(humanizeElapsed(59_960)).toBe("1분");
    expect(humanizeElapsed(59_940)).toBe("59.9초");
  });

  it("shows nothing for a missing or negative time", () => {
    expect(humanizeElapsed(null)).toBeNull();
    expect(humanizeElapsed(-5)).toBeNull();
  });
});
