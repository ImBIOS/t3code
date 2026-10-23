/**
 * Why an OpenCode prompt was refused as oversized.
 *
 * OpenCode reports a session that outgrew the model's context window as a
 * bare InvalidRequest ("The request contains invalid parameters"), which
 * reads as a bug in the request. Retrying the same run then fails
 * identically, because the history that broke the request is still there.
 * This maps that case to an actionable message: fork from an earlier
 * completed run or start a fresh thread.
 *
 * Only fires with positive size evidence — a known window and a turn whose
 * observed input already meets it — so genuine malformed requests keep
 * their original error. A refused first prompt (no steps yet) carries no
 * size signal and is left alone for the same reason.
 */
export const oversizedSessionMessage = (input: {
  readonly causeTag: string | undefined;
  readonly steps: number;
  readonly inputTokens: number;
  readonly windowTokens: number | undefined;
}): string | null => {
  if (input.causeTag !== "InvalidRequestError") return null;
  if (input.windowTokens === undefined || input.steps === 0) return null;
  if (input.inputTokens < input.windowTokens) return null;
  const used = input.inputTokens.toLocaleString("en-US");
  const window = input.windowTokens.toLocaleString("en-US");
  return (
    `This session has grown past the model's context window ` +
    `(${used} tokens used of ${window}). ` +
    `Fork from an earlier completed run or start a fresh thread; ` +
    `retrying this run will fail the same way.`
  );
};
