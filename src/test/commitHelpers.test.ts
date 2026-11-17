import { beforeEach, describe, expect, it } from "vitest";
import {
  appendCoAuthorTrailer,
  loadCommitHistory,
  recordCommitHistory,
} from "../utils/commitHelpers";

describe("commitHelpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("records, deduplicates, and caps commit message history per repo", () => {
    recordCommitHistory("/repo/a", "feat: first");
    recordCommitHistory("/repo/a", "fix: second");
    recordCommitHistory("/repo/a", "feat: first");
    recordCommitHistory("/repo/b", "chore: other repo");

    expect(loadCommitHistory("/repo/a")).toEqual(["feat: first", "fix: second"]);
    expect(loadCommitHistory("/repo/b")).toEqual(["chore: other repo"]);
  });

  it("appends Co-authored-by trailers cleanly with proper blank line spacing", () => {
    expect(appendCoAuthorTrailer("feat: x", "Alice", "alice@example.com")).toBe(
      "feat: x\n\nCo-authored-by: Alice <alice@example.com>",
    );

    const withTwo = appendCoAuthorTrailer(
      "feat: x\n\nCo-authored-by: Alice <alice@example.com>",
      "Bob",
      "bob@example.com",
    );
    expect(withTwo).toBe(
      "feat: x\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Bob <bob@example.com>",
    );

    // 幂等去重
    expect(appendCoAuthorTrailer(withTwo, "Alice", "alice@example.com")).toBe(withTwo);
  });
});
