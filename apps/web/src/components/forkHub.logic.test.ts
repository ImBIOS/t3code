import { describe, expect, it, vi } from "vite-plus/test";

import { checkForkHubOwner, normalizeForkHubOwner, resolveReleasedTrains, resolveSupportedTrains, resolveTrainsFromUpstreamManifest } from "./forkHub.logic";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function manifestResponse(trains: unknown): Response {
  return jsonResponse(200, {
    encoding: "base64",
    content: Buffer.from(JSON.stringify({ trains })).toString("base64"),
  });
}

describe("normalizeForkHubOwner", () => {
  it("trims and accepts profile and org names", () => {
    expect(normalizeForkHubOwner("  ImBIOS ")).toBe("ImBIOS");
    expect(normalizeForkHubOwner("my-org-1")).toBe("my-org-1");
  });

  it("rejects blanks, slashes, and overlong names", () => {
    expect(normalizeForkHubOwner("")).toBeNull();
    expect(normalizeForkHubOwner("owner/repo")).toBeNull();
    expect(normalizeForkHubOwner("-leading")).toBeNull();
    expect(normalizeForkHubOwner("a".repeat(40))).toBeNull();
    expect(normalizeForkHubOwner(42)).toBeNull();
  });
});

describe("checkForkHubOwner", () => {
  it("accepts an owner with public .forkhub releases", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [{ tag_name: "v1.0.0" }]));
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({
      owner: "with-fh",
      repo: ".forkhub",
      latestTag: "v1.0.0",
      hasStableTrain: true,
      hasNightlyTrain: false,
    });
    // Releases call plus manifest call (manifest misses here, tag scan decides).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("labels latest with a version tag, not a newer bundle tag", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { tag_name: "pingdotgg-t3code-v0.0.43-nightly.20260924.2187-fh1" },
        { tag_name: "v0.0.43-nightly.20260924.2187.fh.with-fh.1" },
        { tag_name: "v0.0.42" },
      ]),
    );
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result.latestTag).toBe("v0.0.43-nightly.20260924.2187.fh.with-fh.1");
    expect(result).toMatchObject({ hasStableTrain: true, hasNightlyTrain: true });
  });

  it("reports a nightly-only publisher", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [{ tag_name: "v0.0.43-nightly.20260924.2187.fh.with-fh.1" }]),
    );
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ hasStableTrain: false, hasNightlyTrain: true });
  });

  it("rejects a publisher serving neither train", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { tag_name: "pingdotgg-t3code-v0.0.43-nightly.20260924.2187-fh1" },
        { tag_name: "v0.0.41-preview.20260914.1683" },
      ]),
    );
    await expect(
      checkForkHubOwner("ghost", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("neither the stable nor the nightly train");
  });

  it("rejects owners with no public catalog", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    await expect(
      checkForkHubOwner("ghost", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("no .forkhub releases");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects owners with no releases anywhere", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    await expect(
      checkForkHubOwner("ghost", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("no published releases");
  });

  it("rejects invalid names without calling the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      checkForkHubOwner("not a name!", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("not a valid GitHub profile");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resolveTrainsFromUpstreamManifest", () => {
  it("reads the declared trains", () => {
    expect(resolveTrainsFromUpstreamManifest({ trains: ["nightly"] })).toEqual({
      hasStableTrain: false,
      hasNightlyTrain: true,
    });
    expect(resolveTrainsFromUpstreamManifest({ trains: ["stable", "nightly"] })).toEqual({
      hasStableTrain: true,
      hasNightlyTrain: true,
    });
    expect(resolveTrainsFromUpstreamManifest({ trains: ["Stable"] })).toEqual({
      hasStableTrain: true,
      hasNightlyTrain: false,
    });
  });

  it("returns null without a usable trains list", () => {
    expect(resolveTrainsFromUpstreamManifest({})).toBeNull();
    expect(resolveTrainsFromUpstreamManifest({ trains: ["canary"] })).toBeNull();
    expect(resolveTrainsFromUpstreamManifest(null)).toBeNull();
  });
});

describe("checkForkHubOwner trains", () => {
  it("prefers the catalog manifest over the tag scan", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/contents/")
        ? manifestResponse(["nightly"])
        : jsonResponse(200, [
            { tag_name: "v2.8.1-fh.with-fh.1" },
            { tag_name: "v0.0.43-nightly.20260928.2375.fh.with-fh.1" },
          ]),
    );
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ hasStableTrain: false, hasNightlyTrain: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the tag scan without a manifest entry", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/contents/")
        ? jsonResponse(404, { message: "Not Found" })
        : jsonResponse(200, [{ tag_name: "v1.0.0" }]),
    );
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ hasStableTrain: true, hasNightlyTrain: false });
  });

  it("hides a declared train with no shipped builds", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/contents/")
        ? manifestResponse(["stable", "nightly"])
        : jsonResponse(200, [
            { tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" },
            { tag_name: "v0.0.45-nightly.20260930.2468.fh.with-fh.1" },
          ]),
    );
    const result = await checkForkHubOwner("with-fh", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ hasStableTrain: false, hasNightlyTrain: true });
  });
});

describe("resolveReleasedTrains", () => {
  const slug = "pingdotgg-t3code";
  it("reads trains from this target's bundle tags only", () => {
    expect(
      resolveReleasedTrains(
        [
          { tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" },
          { tag_name: "pingdotgg-t3code--v0.0.44-fh2" },
          // Another target's stable build: not ours.
          { tag_name: "natively-ai-assistant-natively-cluely-ai-assistant--V2.8.8-fh16" },
          { tag_name: "v2.8.8-fh.with-fh.3" },
          // Updater tags carry no target: ignored for verification.
          { tag_name: "v0.0.45-nightly.20260930.2468.fh.with-fh.1" },
          { tag_name: "v2.8.8-fh.with-fh.3", draft: true },
        ],
        slug,
      ),
    ).toEqual({ hasStableTrain: true, hasNightlyTrain: true, hasBundleEvidence: true });
  });

  it("matches capital-V bundle tags and reports no evidence without them", () => {
    expect(
      resolveReleasedTrains(
        [{ tag_name: "PingDotGG-T3Code--V0.0.45-nightly.20260930.2468-fh1" }],
        slug,
      ),
    ).toMatchObject({ hasNightlyTrain: true, hasBundleEvidence: true });
    expect(resolveReleasedTrains([{ tag_name: "v0.0.45-nightly.20260930.2468.fh.with-fh.1" }], slug)).toEqual({
      hasStableTrain: false,
      hasNightlyTrain: false,
      hasBundleEvidence: false,
    });
    expect(resolveReleasedTrains(null, slug).hasBundleEvidence).toBe(false);
  });
});

describe("resolveSupportedTrains", () => {
  it("intersects declared trains with shipped builds", () => {
    const nightlyOnlyBundles = [{ tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" }];
    expect(
      resolveSupportedTrains({ hasStableTrain: true, hasNightlyTrain: true }, nightlyOnlyBundles),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: true });
    expect(
      resolveSupportedTrains({ hasStableTrain: false, hasNightlyTrain: true }, nightlyOnlyBundles),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: true });
  });

  it("trusts the manifest without bundle evidence", () => {
    const declared = { hasStableTrain: true, hasNightlyTrain: true };
    expect(resolveSupportedTrains(declared, [{ tag_name: "v1.0.0" }])).toEqual(declared);
    expect(resolveSupportedTrains(declared, null)).toEqual(declared);
  });
});
