import type { ImageTaskProtocol } from "./contracts/providers.js";
import channelProtocols from "./contracts/tuda-managed-channel-protocols.json" with { type: "json" };

export const imageTaskProtocols = Object.keys(channelProtocols.imageTaskProtocols);
const taskEndpointPattern = new RegExp(channelProtocols.imageTaskEndpointPattern, "u");

export function isImageTaskProtocol(value: unknown): value is ImageTaskProtocol {
  return typeof value === "string" && Object.hasOwn(channelProtocols.imageTaskProtocols, value);
}

export function isImageTaskEndpoint(value: string): boolean {
  return taskEndpointPattern.test(value) && !value.includes("..");
}
