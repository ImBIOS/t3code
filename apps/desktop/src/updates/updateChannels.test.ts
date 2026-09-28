import { describe, expect, it } from "vite-plus/test";

import {
  isForkHubDerivedVersion,
  isNightlyDesktopVersion,
  isVersionAllowedOnUpdateChannel,
  normalizeForkHubOwner,
  resolveDefaultDesktopUpdateChannel,
  resolveForkHubFeedConfig,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
    expect(isNightlyDesktopVersion("0.0.43-nightly.20260924.2187.fh.imbios.1")).toBe(true);
  });

  it("normalizes ForkHub owner names like GitHub does", () => {
    expect(normalizeForkHubOwner("  ImBIOS ")).toBe("ImBIOS");
    expect(normalizeForkHubOwner("my-org")).toBe("my-org");
    expect(normalizeForkHubOwner("")).toBeNull();
    expect(normalizeForkHubOwner("owner/repo")).toBeNull();
    expect(normalizeForkHubOwner("-nope")).toBeNull();
  });

  it("points the ForkHub feed at the owner's catalog repo", () => {
    expect(resolveForkHubFeedConfig({ owner: "ImBIOS" })).toEqual({
      provider: "github",
      owner: "ImBIOS",
      repo: ".forkhub",
    });
    expect(resolveForkHubFeedConfig({ owner: "not valid!" })).toBeNull();
  });

  it("keeps each track on its own train", () => {
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "latest", false)).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "latest", false)).toBe(
      false,
    );
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "nightly", false)).toBe(
      true,
    );
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "nightly", false)).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.41-preview.20260911.7", "nightly", false)).toBe(
      false,
    );
  });

  it("matches provenance to the install on ForkHub builds", () => {
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187.fh.with-fh.1")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.42-fh.with-fh.2")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187")).toBe(false);
    expect(isForkHubDerivedVersion("0.0.42")).toBe(false);
    // A ForkHub install follows its publisher's catalog on the selected
    // track: nightly- and stable-based builds on either.
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1", "nightly", true),
    ).toBe(true);
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1", "latest", true),
    ).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "latest", true)).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "nightly", true)).toBe(true);
    // Cross-provenance never installs: stock builds stay out of ForkHub
    // installs, ForkHub builds stay out of stock installs.
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "latest", true)).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "nightly", true)).toBe(
      false,
    );
    expect(
      isVersionAllowedOnUpdateChannel(
        "0.0.43-nightly.20260924.2187.fh.with-fh.1",
        "nightly",
        false,
      ),
    ).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "latest", false)).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1")).toBe(
      "nightly",
    );
    expect(resolveDefaultDesktopUpdateChannel("0.0.42-fh.with-fh.1")).toBe("latest");
  });
});
