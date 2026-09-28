import { describe, expect, it, vi } from "vite-plus/test";

import { checkForkHubOwner, normalizeForkHubOwner, resolveTrainsFromUpstreamManifest } from "./forkHub.logic";

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
});
