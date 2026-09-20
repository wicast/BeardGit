import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pathBasename,
  joinRepoPath,
  copyPathMenuItems,
} from "./copy-path-menu";

describe("pathBasename", () => {
  it("returns the last segment of a file path", () => {
    expect(pathBasename("src/lib/app.ts")).toBe("app.ts");
  });

  it("strips a trailing slash from directories", () => {
    expect(pathBasename("src/lib/")).toBe("lib");
    expect(pathBasename("src/lib")).toBe("lib");
  });

  it("handles a bare filename", () => {
    expect(pathBasename("README.md")).toBe("README.md");
  });

  it("normalises backslashes before cutting", () => {
    expect(pathBasename("src\\lib\\app.ts")).toBe("app.ts");
  });
});

describe("joinRepoPath", () => {
  it("joins root and relative path with a single slash", () => {
    expect(joinRepoPath("/repo", "src/app.ts")).toBe("/repo/src/app.ts");
  });

  it("tolerates trailing slashes on the root", () => {
    expect(joinRepoPath("/repo/", "src/app.ts")).toBe("/repo/src/app.ts");
    expect(joinRepoPath("/repo///", "src/app.ts")).toBe("/repo/src/app.ts");
  });

  it("strips a leading slash from the relative path", () => {
    expect(joinRepoPath("/repo", "/src/app.ts")).toBe("/repo/src/app.ts");
  });

  it("falls back to the relative path when no root is known", () => {
    expect(joinRepoPath(null, "src/app.ts")).toBe("src/app.ts");
    expect(joinRepoPath(undefined, "src/app.ts")).toBe("src/app.ts");
    expect(joinRepoPath("", "src/app.ts")).toBe("src/app.ts");
  });

  it("normalises Windows-style separators to forward slashes", () => {
    expect(joinRepoPath("D:\\repo", "src\\app.ts")).toBe("D:/repo/src/app.ts");
  });
});

describe("copyPathMenuItems", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns three contiguous items (name, relative, absolute)", () => {
    const items = copyPathMenuItems("src/app.ts", "/repo");
    expect(items).toHaveLength(3);
    expect(items.every((i) => !i.separator)).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("copies basename, repo-relative path, and absolute path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const items = copyPathMenuItems("src/app.ts", "/repo");
    items[0].action?.();
    items[1].action?.();
    items[2].action?.();
    await Promise.resolve();

    expect(writeText).toHaveBeenNthCalledWith(1, "app.ts");
    expect(writeText).toHaveBeenNthCalledWith(2, "src/app.ts");
    expect(writeText).toHaveBeenNthCalledWith(3, "/repo/src/app.ts");
  });
});
