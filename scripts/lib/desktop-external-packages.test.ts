import { assert, describe, it } from "@effect/vitest";

import {
  findInlinedDesktopExternalPackages,
  isDesktopRuntimeExternalDependency,
  selectDesktopRuntimeExternalDependencies,
} from "./desktop-external-packages.ts";

describe("isDesktopRuntimeExternalDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of ["effect", "@effect/platform", "electron-store"]) {
      assert.strictEqual(isDesktopRuntimeExternalDependency(id), false, id);
    }
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "@napi-rs/keyring",
      "@crowecawcaw/xa11y",
      "@clerk/electron-passkeys",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "playwright-core",
    ]) {
      assert.strictEqual(isDesktopRuntimeExternalDependency(id), true, id);
    }
  });

  // Regression test for #11720: an inlined dbus-next makes the lazy
  // PortalCaptureShortcut/NiriCaptureShortcut chunk require("./main.cjs"),
  // which re-evaluates top-level runMain after Electron is ready and exits
  // every Linux Wayland launch with `registerSchemesAsPrivileged` throwing.
  it("leaves dbus-next external, including subpath imports", () => {
    for (const id of ["dbus-next", "dbus-next/lib/bus"]) {
      assert.strictEqual(isDesktopRuntimeExternalDependency(id), true, id);
    }
  });
});

describe("selectDesktopRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the stage", () => {
    assert.deepStrictEqual(
      selectDesktopRuntimeExternalDependencies({
        "dbus-next": "0.10.2",
        effect: "3.0.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
      }),
      {
        "dbus-next": "0.10.2",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
      },
    );
  });
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedDesktopExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an inlined dbus-next", () => {
    const source =
      region("../../node_modules/.pnpm/dbus-next@0.10.2/node_modules/dbus-next/lib/bus.js") +
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js");
    const result = findInlinedDesktopExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["dbus-next"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../apps/desktop/src/main.ts");
    const result = findInlinedDesktopExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/sax@1.4.1/node_modules/sax/lib/sax.js");
    const result = findInlinedDesktopExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "sax"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("reports no regions when the marker format is absent", () => {
    const result = findInlinedDesktopExternalPackages(
      "var x = 1; // node_modules/dbus-next/lib.js",
    );
    assert.strictEqual(result.regionCount, 0);
    assert.deepStrictEqual(result.inlined, []);
  });
});
