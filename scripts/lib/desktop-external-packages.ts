/**
 * Packages the desktop main-process bundle must NOT inline.
 *
 * The desktop bundle follows the same policy as the server CLI bundle (see
 * cli-external-packages.ts): everything is inlined except what Node has to
 * load from the real filesystem. Both `apps/desktop/vite.config.ts` and the
 * artifact stage in scripts/build-desktop-artifact.ts derive from this list,
 * so a package that is external is also the only kind of package the staged
 * production install carries. Anything not listed here ships inside
 * `dist-electron/*.cjs` and has no `node_modules` presence at all.
 *
 * Entries are matched as prefixes so platform-specific siblings are covered.
 */
export const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  // Native addons and the wrappers that dlopen them by real path.
  "@napi-rs/keyring",
  "@crowecawcaw/xa11y",
  "@clerk/electron-passkeys",
  "ffi-rs",
  "@yuuang/",
  // Reads its own bundle from disk by resolving `playwright-core/package.json`
  // at runtime and ships the browser driver alongside; there is nothing to
  // gain from inlining a 10 MB file the code re-reads as text.
  "playwright-core",
  // dbus-next must stay a real node_modules package. Inlined, the bundler
  // hoists its `sax` import into the main-process entry chunk, so the lazy
  // PortalCaptureShortcut/NiriCaptureShortcut chunk ends up with
  // `require("./main.cjs")`. On Linux Wayland portal sessions that chunk loads
  // after Electron is ready, the entry re-evaluates top-level `runMain`, and
  // `protocol.registerSchemesAsPrivileged` throws — every launch exits 1
  // before a window appears (#11720).
  "dbus-next",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Select the desktop dependency roots whose runtime closure the stage must install. */
export function selectDesktopRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isDesktopRuntimeExternalDependency(name)),
  );
}

/**
 * Scan an emitted `dist-electron` chunk for desktop runtime-external packages
 * that were inlined.
 *
 * Same shape as `findInlinedExternalPackages` in cli-external-packages.ts, but
 * against the desktop predicate: the artifact build scans `serverDist` with
 * the CLI list, which does not know `dbus-next`, so an inlined dbus-next
 * passed packaging silently and broke every Linux Wayland launch (#11720).
 * `regionCount` and `inlinedPackages` carry the same blind-scan protection.
 */
export function findInlinedDesktopExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` comment.
  const regionPattern = /\/\/#region\s+(\S+)/g;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isDesktopRuntimeExternalDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}
