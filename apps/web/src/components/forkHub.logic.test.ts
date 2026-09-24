import { describe, expect, it, vi } from "vite-plus/test";

import { checkForkHubOwner, normalizeForkHubOwner } from "./forkHub.logic";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
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
    const result = await checkForkHubOwner("ImBIOS", fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ owner: "ImBIOS", repo: ".forkhub", latestTag: "v1.0.0" });
    expect(fetchImpl).toHaveBeenCalledOnce();
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
