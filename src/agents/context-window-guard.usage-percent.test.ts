import { describe, expect, it } from "vitest";
import { getContextUsagePercent } from "./context-window-guard.js";

describe("getContextUsagePercent", () => {
  it("calculates normal usage percentage", () => {
    const result = getContextUsagePercent({ totalTokens: 80_000 }, 200_000);
    expect(result).toBe(40);
  });

  it("uses configContextTokens over modelContextWindow when provided", () => {
    const result = getContextUsagePercent({ totalTokens: 80_000 }, 200_000, 100_000);
    expect(result).toBe(80);
  });

  it("returns 0 when effective window is zero", () => {
    const result = getContextUsagePercent({ totalTokens: 80_000 }, 0);
    expect(result).toBe(0);
  });

  it("returns 0 when effective window is negative", () => {
    const result = getContextUsagePercent({ totalTokens: 80_000 }, -1);
    expect(result).toBe(0);
  });

  it("returns 0 when totalTokens is missing", () => {
    const result = getContextUsagePercent({}, 200_000);
    expect(result).toBe(0);
  });

  it("returns exactly 100 when fully used", () => {
    const result = getContextUsagePercent({ totalTokens: 200_000 }, 200_000);
    expect(result).toBe(100);
  });

  it("rounds to nearest integer", () => {
    // 33333 / 100000 = 33.333%
    const result = getContextUsagePercent({ totalTokens: 33_333 }, 100_000);
    expect(result).toBe(33);
  });

  it("returns 0 when configContextTokens is zero", () => {
    const result = getContextUsagePercent({ totalTokens: 80_000 }, 200_000, 0);
    expect(result).toBe(0);
  });
});
