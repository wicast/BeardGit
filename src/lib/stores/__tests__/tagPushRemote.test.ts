/**
 * Unit tests for the remote a tag push targets.
 *
 * The point of this store is that two surfaces (the list footer's "Push all
 * tags" and the tag detail footer's "Push") share one selection, and that
 * the selection is validated against the *current* repo's remotes — the
 * preference is session-global, remotes are not.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

import { remotes, __resetRemotesForTests } from "../remotes";
import {
  preferredTagRemote,
  tagPushRemote,
  setTagPushRemote,
  __resetTagPushRemoteForTests,
} from "../tagPushRemote";
import { __resetViewMemory } from "../viewMemory";

function setRemotes(...names: string[]): void {
  remotes.set(names.map((name) => ({ name, url: null })));
}

describe("tagPushRemote", () => {
  beforeEach(() => {
    __resetRemotesForTests();
    __resetTagPushRemoteForTests();
    __resetViewMemory();
  });

  it("is null when the repository has no remotes", () => {
    expect(get(tagPushRemote)).toBeNull();
  });

  it("defaults to origin when one exists", () => {
    setRemotes("upstream", "origin");
    expect(get(tagPushRemote)).toBe("origin");
  });

  it("falls back to the first remote when there is no origin", () => {
    setRemotes("fork", "mirror");
    expect(get(tagPushRemote)).toBe("fork");
  });

  it("honours an explicit choice", () => {
    setRemotes("origin", "upstream");
    setTagPushRemote("upstream");
    expect(get(tagPushRemote)).toBe("upstream");
  });

  it("ignores a choice this repository does not have", () => {
    setRemotes("origin", "upstream");
    setTagPushRemote("upstream");

    // Same session, another project: the remembered name is not a remote
    // here, so pushing must not be aimed at `git push upstream` blindly.
    setRemotes("origin");
    expect(get(tagPushRemote)).toBe("origin");
  });

  it("recovers the choice when the remote comes back", () => {
    setRemotes("origin", "upstream");
    setTagPushRemote("upstream");
    setRemotes("origin");
    expect(get(tagPushRemote)).toBe("origin");

    setRemotes("origin", "upstream");
    expect(get(tagPushRemote)).toBe("upstream");
  });

  it("keeps the remembered name when the last remote disappears", () => {
    setRemotes("origin");
    setTagPushRemote("origin");
    setRemotes();
    // Nothing to push to, but forgetting the preference would silently
    // reset it the next time the repo has remotes again.
    expect(get(tagPushRemote)).toBeNull();
    expect(get(preferredTagRemote)).toBe("origin");
  });

  it("follows the store as remotes arrive asynchronously", () => {
    // TagView refreshes tags and remotes together; the picker must go from
    // empty to populated off the store, not off a one-shot read.
    expect(get(tagPushRemote)).toBeNull();
    setRemotes("origin", "upstream");
    expect(get(tagPushRemote)).toBe("origin");
  });
});
