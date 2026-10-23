import { describe, expect, it } from "@effect/vitest";

import { oversizedSessionMessage } from "./oversizedSession.ts";

describe("oversizedSessionMessage", () => {
  it("maps a window-exceeding InvalidRequest to the actionable message", () => {
    expect(
      oversizedSessionMessage({
        causeTag: "InvalidRequestError",
        steps: 12,
        inputTokens: 8_700_000,
        windowTokens: 1_000_000,
      }),
    ).toBe(
      "This session has grown past the model's context window " +
        "(8,700,000 tokens used of 1,000,000). " +
        "Fork from an earlier completed run or start a fresh thread; " +
        "retrying this run will fail the same way.",
    );
  });

  it("fires exactly at the window boundary", () => {
    expect(
      oversizedSessionMessage({
        causeTag: "InvalidRequestError",
        steps: 1,
        inputTokens: 200_000,
        windowTokens: 200_000,
      }),
    ).not.toBeNull();
  });

  it("leaves other rejections alone", () => {
    expect(
      oversizedSessionMessage({
        causeTag: "ConflictError",
        steps: 12,
        inputTokens: 8_700_000,
        windowTokens: 1_000_000,
      }),
    ).toBeNull();
  });

  it("leaves below-window requests alone", () => {
    expect(
      oversizedSessionMessage({
        causeTag: "InvalidRequestError",
        steps: 12,
        inputTokens: 50_000,
        windowTokens: 1_000_000,
      }),
    ).toBeNull();
  });

  it("leaves unknown windows and prompt-less failures alone", () => {
    expect(
      oversizedSessionMessage({
        causeTag: "InvalidRequestError",
        steps: 12,
        inputTokens: 8_700_000,
        windowTokens: undefined,
      }),
    ).toBeNull();
    expect(
      oversizedSessionMessage({
        causeTag: "InvalidRequestError",
        steps: 0,
        inputTokens: 0,
        windowTokens: 1_000_000,
      }),
    ).toBeNull();
  });
});
