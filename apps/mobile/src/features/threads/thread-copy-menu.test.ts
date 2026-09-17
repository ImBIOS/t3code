import { describe, expect, it } from "vite-plus/test";

import { buildThreadCopyMenuActions, resolveThreadCopyPath } from "./thread-copy-menu";

describe("buildThreadCopyMenuActions", () => {
  it("offers Path, Branch, and Thread ID when the thread has a branch", () => {
    const actions = buildThreadCopyMenuActions({ branch: "feature/mobile-copy" });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("copy");
    expect(actions[0]?.subactions?.map((action) => action.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
  });

  it("omits Branch when the thread has none", () => {
    const actions = buildThreadCopyMenuActions({ branch: null });
    expect(actions[0]?.subactions?.map((action) => action.id)).toEqual([
      "copy-path",
      "copy-thread-id",
    ]);
  });
});

describe("resolveThreadCopyPath", () => {
  it("prefers the worktree path over the project root", () => {
    expect(
      resolveThreadCopyPath({ worktreePath: "/worktrees/a", projectWorkspaceRoot: "/repo" }),
    ).toBe("/worktrees/a");
  });

  it("falls back to the project root", () => {
    expect(resolveThreadCopyPath({ worktreePath: null, projectWorkspaceRoot: "/repo" })).toBe(
      "/repo",
    );
  });

  it("returns null when no path exists", () => {
    expect(resolveThreadCopyPath({ worktreePath: null })).toBeNull();
  });
});
