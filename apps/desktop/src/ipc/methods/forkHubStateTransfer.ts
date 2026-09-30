import {
  ForkHubStateTransferDirectionSchema,
  ForkHubStateTransferPreviewSchema,
  ForkHubStateTransferResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  applyForkHubStateTransfer as applyTransfer,
  previewForkHubStateTransfer as previewTransfer,
} from "../../app/DesktopForkHubStateTransfer.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ForkHubStateTransferDirectionInputSchema = Schema.Struct({
  direction: ForkHubStateTransferDirectionSchema,
});

export const previewForkHubStateTransfer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORKHUB_STATE_TRANSFER_PREVIEW_CHANNEL,
  payload: ForkHubStateTransferDirectionInputSchema,
  result: ForkHubStateTransferPreviewSchema,
  handler: Effect.fn("desktop.ipc.forkhubStateTransfer.preview")(function* (
    input: typeof ForkHubStateTransferDirectionInputSchema.Type,
  ) {
    return yield* previewTransfer(input.direction);
  }),
});

export const applyForkHubStateTransfer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORKHUB_STATE_TRANSFER_APPLY_CHANNEL,
  payload: ForkHubStateTransferDirectionInputSchema,
  result: ForkHubStateTransferResultSchema,
  handler: Effect.fn("desktop.ipc.forkhubStateTransfer.apply")(function* (
    input: typeof ForkHubStateTransferDirectionInputSchema.Type,
  ) {
    return yield* applyTransfer(input.direction);
  }),
});
