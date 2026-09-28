// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
} from "./DesktopEarlyElectronStartup.ts";

describe("DesktopEarlyElectronStartup", () => {
  const joinPath = NodePath.posix.join;

  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("accepts JSONC in the early desktop settings file", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: () => `{
        // manually edited setting
        "linuxPasswordStore": "gnome-libsecret",
      }`,
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("falls back to auto when the early settings document is missing or invalid", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: () => {
        throw new Error("missing");
      },
    });

    assert.equal(preference, "auto");
  });

  it("preserves absolute root paths when resolving early settings", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
    });

    assert.deepEqual(options, {
      isDevelopment: true,
      linuxWmClass: "t3code-dev",
      linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
      passwordStore: "gnome-libsecret",
    });
  });

  it("keeps implicit development state under ~/.t3/dev when T3CODE_HOME is unset", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  it("resolves ForkHub installs to their own settings home and Electron identity", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.43-nightly.20260924.2187.fh.imbios.1",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-forkhub/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.deepEqual(options, {
      isDevelopment: false,
      linuxWmClass: "t3code-forkhub",
      linuxDesktopEntryName: "com.t3tools.T3Code.ForkHub.desktop",
      passwordStore: "kwallet6",
    });
  });

  it("keeps an explicit T3CODE_HOME for ForkHub installs", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.43-nightly.20260924.2187.fh.imbios.1",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  it("treats whitespace-only T3CODE_HOME as unconfigured in development", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        T3CODE_HOME: "   ",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: "0.0.22",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "gnome-libsecret" });
      },
    });

    assert.equal(preference, "gnome-libsecret");
  });
});
