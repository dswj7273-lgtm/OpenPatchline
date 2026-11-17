import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyMatchAny } from "../keyboard/fuzzyMatch";

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("fp", "fetch --prune")).not.toBeNull();
    expect(fuzzyMatch("CHK", "checkout branch")).not.toBeNull();
    expect(fuzzyMatch("切换", "切换到分支")).not.toBeNull();
  });

  it("rejects non-subsequences", () => {
    expect(fuzzyMatch("pushx", "push")).toBeNull();
    expect(fuzzyMatch("zb", "分支切换")).toBeNull();
  });

  it("empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
    expect(fuzzyMatch("   ", "anything")).toBe(0);
  });

  it("prefers word starts and consecutive runs", () => {
    const wordStart = fuzzyMatch("pb", "push branch");
    const scattered = fuzzyMatch("pb", "pick up broken");
    expect(wordStart).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(wordStart!).toBeGreaterThan(scattered!);

    const consecutive = fuzzyMatch("push", "push");
    const nonMatch = fuzzyMatch("push", "stash pull");
    expect(nonMatch).toBeNull();
    expect(consecutive!).toBeGreaterThan(0);
  });

  it("fuzzyMatchAny takes best score across texts", () => {
    const best = fuzzyMatchAny("pull", ["push 拉取", "pull rebase 变基拉取"]);
    expect(best).not.toBeNull();
    expect(fuzzyMatchAny("xyz", ["abc"])).toBeNull();
  });
});
