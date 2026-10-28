// @effect-diagnostics nodeBuiltinImport:off - setup-script bootstrap, runs before any Effect runtime exists.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (sh, bash, zsh, fish, PowerShell): it installs
 * dependencies through the repo's own `vp` (never a same-named binary from
 * PATH), links the project root's gitignored env files into this worktree,
 * then warms the web dependency cache.
 *
 * `vp` is invoked as `node node_modules/vite-plus/bin/vp` (falling back to
 * `node_modules/.bin/vp`) so a PATH entry like the ATFS `vp` pager can never
 * shadow it — that pager exits 0 after printing "nothing found", which used
 * to skip the install and fail the later warm step with a missing `vite`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);

function findVpEntry(): string | null {
  const candidates = [
    NodePath.join(worktree, "node_modules", "vite-plus", "bin", "vp"),
    NodePath.join(worktree, "node_modules", ".bin", "vp"),
  ];
  for (const candidate of candidates) {
    try {
      if (NodeFS.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Missing entry — try the next candidate.
    }
  }
  return null;
}

// The repo's own vp installs even when node_modules is absent (fresh
// worktree) or PATH carries another `vp`. Only when neither entry exists do
// we fall back to PATH, so a missing install still surfaces vp's own error.
const vpEntry = findVpEntry();
const install = vpEntry
  ? NodeChildProcess.spawnSync(process.execPath, [vpEntry, "i"], {
      cwd: worktree,
      stdio: "inherit",
    })
  : NodeChildProcess.spawnSync("vp i", {
      cwd: worktree,
      shell: true,
      stdio: "inherit",
    });
if (install.status !== 0) process.exit(install.status ?? 1);

// In the project root itself, relinking would replace the real env files.
if (NodeFS.realpathSync(projectRoot) !== NodeFS.realpathSync(worktree)) {
  for (const file of ENV_FILES) {
    const source = NodePath.join(projectRoot, file);
    if (!NodeFS.existsSync(source)) continue;
    const target = NodePath.join(worktree, file);
    NodeFS.rmSync(target, { force: true });
    NodeFS.symlinkSync(source, target);
  }
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
