import type { MenuAction } from "@react-native-menu/menu";

/**
 * Mobile Copy submenu mirroring desktop's threadActionMenu Copy group
 * (Path, Branch when present, Thread ID).
 * See `apps/web/src/components/threadActionMenu.logic.ts`.
 */
export function buildThreadCopyMenuActions(input: {
  readonly branch: string | null;
}): MenuAction[] {
  return [
    {
      id: "copy",
      title: "Copy",
      image: "doc.on.doc",
      subactions: [
        { id: "copy-path", title: "Path", image: "folder" },
        ...(input.branch
          ? [
              {
                id: "copy-branch",
                title: "Branch",
                image: "arrow.triangle.branch",
              } satisfies MenuAction,
            ]
          : []),
        { id: "copy-thread-id", title: "Thread ID", image: "number" },
      ],
    },
  ];
}

/**
 * Desktop copies `thread.worktreePath ?? projectCwd` and toasts when neither
 * exists. Mobile rows resolve the same way: v2 rows pass the project
 * workspace root, v1 rows pass only the worktree path.
 */
export function resolveThreadCopyPath(input: {
  readonly worktreePath: string | null;
  readonly projectWorkspaceRoot?: string | null | undefined;
}): string | null {
  return input.worktreePath ?? input.projectWorkspaceRoot ?? null;
}
