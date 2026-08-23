import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { Platform } from "react-native";

export function authClientMetadata(
  input: { readonly appVersion?: string; readonly instanceId?: string } = {},
): AuthClientPresentationMetadata {
  return {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    surface: "mobile",
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
  };
}
