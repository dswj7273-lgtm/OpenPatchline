import { describe, expect, it } from "vitest";
import { buildCompactFileTree } from "../utils/fileTree";

describe("buildCompactFileTree", () => {
  it("compacts single-child directory chains and keeps branch points", () => {
    const tree = buildCompactFileTree(
      [
        { path: "opm/smartwe-opm-ui/src/views/cmdb/resourceaccess/index.vue" },
        { path: "opm/smartwe-opm-ui/src/views/monitor/cloudaccess/Drawer.vue" },
        { path: "opm/smartwe-opm-ui/src/views/monitor/cloudaccess/index.vue" },
        { path: "mod/src/main/java/vo/Req.java" },
        { path: "mod/src/main/java/vo/Res.java" },
      ],
      "zd-tl",
    );

    expect(tree.label).toBe("zd-tl");
    expect(tree.fileCount).toBe(5);
    expect(tree.location).toBe("");
    expect(tree.dirs.map((dir) => dir.label)).toEqual([
      "mod/src/main/java/vo",
      "opm/smartwe-opm-ui/src/views",
    ]);
    expect(tree.dirs[0].location).toBe("zd-tl");
    expect(tree.dirs[0].files.map((file) => file.name)).toEqual(["Req.java", "Res.java"]);
    expect(tree.dirs[0].files.map((file) => file.index)).toEqual([3, 4]);

    const opm = tree.dirs[1];
    expect(opm.fileCount).toBe(3);
    expect(opm.dirs.map((dir) => dir.label)).toEqual([
      "cmdb/resourceaccess",
      "monitor/cloudaccess",
    ]);
    expect(opm.dirs[0].location).toBe("opm/smartwe-opm-ui/src/views");
    expect(opm.dirs[0].files[0]).toMatchObject({ name: "index.vue", index: 0 });
    expect(opm.dirs[1].files.map((file) => file.name)).toEqual(["Drawer.vue", "index.vue"]);
  });

  it("does not merge the repository root or a directory that contains a file", () => {
    const tree = buildCompactFileTree(
      [{ path: "README.md" }, { path: "src/pkg/a.ts" }, { path: "src/notes.md" }],
      "repo",
    );

    expect(tree.label).toBe("repo");
    expect(tree.files.map((file) => file.name)).toEqual(["README.md"]);
    expect(tree.dirs.map((dir) => dir.label)).toEqual(["src"]);
    expect(tree.dirs[0].files.map((file) => file.name)).toEqual(["notes.md"]);
    expect(tree.dirs[0].dirs.map((dir) => dir.label)).toEqual(["pkg"]);
  });

  it("falls back when the root label is blank", () => {
    const tree = buildCompactFileTree([{ path: "a.ts" }], "  ");
    expect(tree.label).toBe("仓库");
    expect(tree.files[0].name).toBe("a.ts");
  });
});
