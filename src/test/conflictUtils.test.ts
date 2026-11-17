import { describe, expect, it } from "vitest";
import {
  applyConflictChoice,
  countConflictBlocks,
  hasConflictMarkers,
  parseConflictSegments,
  resolveAllConflictBlocks,
  type ConflictBlock,
} from "../components/ConflictView/conflictUtils";

const SAMPLE_CONFLICT = [
  "header",
  "<<<<<<< HEAD",
  "const x = 1;",
  "=======\r",
  "const x = 2;",
  ">>>>>>> topic",
  "footer",
  "",
].join("\n");

const SAMPLE_DIFF3 = [
  "a",
  "<<<<<<< HEAD",
  "ours line",
  "||||||| merged common ancestors",
  "base line",
  "=======",
  "theirs line",
  ">>>>>>> feature",
  "b",
  "",
].join("\n");

describe("conflictUtils", () => {
  it("parses standard conflict markers and applies single choices accurately", () => {
    const segments = parseConflictSegments(SAMPLE_CONFLICT);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "text", content: "header\n", startLine: 1 });
    const block = segments[1] as ConflictBlock;
    expect(block.kind).toBe("conflict");
    expect(block.oursLabel).toBe("HEAD");
    expect(block.theirsLabel).toBe("topic");
    expect(block.oursText).toBe("const x = 1;\n");
    expect(block.theirsText).toBe("const x = 2;\n");
    expect(block.baseText).toBeNull();
    expect(segments[2]).toMatchObject({ kind: "text", content: "footer\n", startLine: 7 });

    expect(applyConflictChoice(SAMPLE_CONFLICT, block, "ours")).toBe(
      "header\nconst x = 1;\nfooter\n",
    );
    expect(applyConflictChoice(SAMPLE_CONFLICT, block, "theirs")).toBe(
      "header\nconst x = 2;\nfooter\n",
    );
    expect(applyConflictChoice(SAMPLE_CONFLICT, block, "both-ours-first")).toBe(
      "header\nconst x = 1;\nconst x = 2;\nfooter\n",
    );
    expect(applyConflictChoice(SAMPLE_CONFLICT, block, "both-theirs-first")).toBe(
      "header\nconst x = 2;\nconst x = 1;\nfooter\n",
    );
  });

  it("supports diff3 base markers and batch resolution", () => {
    const segments = parseConflictSegments(SAMPLE_DIFF3);
    const block = segments[1] as ConflictBlock;
    expect(block.baseLabel).toBe("merged common ancestors");
    expect(block.baseText).toBe("base line\n");
    expect(applyConflictChoice(SAMPLE_DIFF3, block, "base")).toBe("a\nbase line\nb\n");

    const multi = `${SAMPLE_CONFLICT}${SAMPLE_DIFF3}`;
    expect(countConflictBlocks(multi)).toBe(2);
    const resolved = resolveAllConflictBlocks(multi, "theirs");
    expect(countConflictBlocks(resolved)).toBe(0);
    expect(hasConflictMarkers(resolved)).toBe(false);
    expect(resolved).toBe("header\nconst x = 2;\nfooter\na\ntheirs line\nb\n");
  });

  it("detects dangling markers without false-positiving on markdown headings", () => {
    expect(hasConflictMarkers("Title\n=======\nBody\n")).toBe(false);
    expect(hasConflictMarkers("<<<<<<< HEAD\nleft\n")).toBe(true);
    expect(hasConflictMarkers(">>>>>>> branch\n")).toBe(true);
    expect(parseConflictSegments("<<<<<<< HEAD\nunclosed\n")).toHaveLength(1);
  });
});
