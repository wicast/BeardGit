import { describe, it, expect } from "vitest";
import { refKind, refLabel, refBranchName } from "./ref";
import { defaultGraphTheme, refColor } from "../components/graph/graph-renderer";

describe("refKind", () => {
  it("classifies a ref by its fully-qualified prefix", () => {
    expect(refKind("refs/heads/main")).toBe("branch");
    expect(refKind("refs/heads/feat/x")).toBe("branch");
    expect(refKind("refs/remotes/origin/main")).toBe("remote");
    expect(refKind("refs/tags/v1.0")).toBe("tag");
    expect(refKind("HEAD")).toBe("head");
  });

  it("falls back to 'other' for non-standard refs", () => {
    expect(refKind("refs/stash")).toBe("other");
    expect(refKind("refs/notes/HEAD")).toBe("other");
    expect(refKind("refs")).toBe("other");
  });

  it("never misclassifies an unqualified name as a branch", () => {
    // The regression that shipped: a stripped `v1.0` could not be told apart
    // from a branch of the same name, so tags wore the branch badge colour.
    expect(refKind("v1.0")).toBe("other");
    expect(refKind("main")).toBe("other");
  });
});

describe("refLabel", () => {
  it("strips the kind prefix", () => {
    expect(refLabel("refs/heads/main")).toBe("main");
    expect(refLabel("refs/remotes/origin/main")).toBe("origin/main");
    expect(refLabel("refs/tags/v1.0")).toBe("v1.0");
    expect(refLabel("HEAD")).toBe("HEAD");
  });

  it("strips the generic refs/ prefix for unknown refs", () => {
    expect(refLabel("refs/stash")).toBe("stash");
    expect(refLabel("refs/notes/HEAD")).toBe("notes/HEAD");
  });

  it("returns unqualified names unchanged", () => {
    expect(refLabel("v1.0")).toBe("v1.0");
  });
});

describe("refBranchName", () => {
  it("returns the branch for a heads ref", () => {
    expect(refBranchName("refs/heads/main")).toBe("main");
    expect(refBranchName("refs/heads/feat/x")).toBe("feat/x");
  });

  it("returns null for tags, remotes and other refs", () => {
    expect(refBranchName("refs/tags/v1.0")).toBeNull();
    expect(refBranchName("refs/remotes/origin/main")).toBeNull();
    expect(refBranchName("HEAD")).toBeNull();
  });
});

describe("ref badge colour by kind", () => {
  it("gives a tag a different colour from a same-named branch", () => {
    const theme = defaultGraphTheme();
    expect(refColor("refs/tags/v1.0", theme)).toBe(theme.refBadge.tag);
    expect(refColor("refs/heads/v1.0", theme)).toBe(theme.refBadge.branch);
    expect(refColor("refs/tags/v1.0", theme)).not.toBe(refColor("refs/heads/v1.0", theme));
  });
});
