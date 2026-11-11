import path from "node:path";
import { DeviceMcp, deviceMcpVersion } from "./device-mcp";
import { IphoneMcp, iphoneUseVersion } from "./iphone-mcp";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { dataDir } from "./store";

export type PhoneBackend = "iphone-use" | "device-mcp";
export type PhoneCapabilities = {
  /** Navigation taps run without a follow-up screenshot. */
  blindNavigation: boolean;
  /** The first confident appraisal frame is accepted without a second read. */
  singleAppraisalFrame: boolean;
};
export interface PhoneConnection {
  readonly backend: PhoneBackend;
  readonly capabilities: PhoneCapabilities;
  call<T extends Record<string, unknown> = Record<string, unknown>>(name: string, args?: Record<string, unknown>, timeout?: number): Promise<T>;
  typeSearch(query: string): Promise<void>;
  close(): void;
}

export function createPhoneConnection(config: RuntimeConfig = getRuntimeConfig()): PhoneConnection {
  if (config.phoneBackend === "device-mcp")
    return new DeviceMcp({
      executable: config.deviceMcpExecutable,
      device: config.deviceMcpDevice,
      imageDir: path.join(dataDir, "device-mcp"),
    });
  return new IphoneMcp();
}

/** Version recorded on scans; it names the backend so results stay traceable. */
export function phoneBackendVersion(config: RuntimeConfig = getRuntimeConfig()) {
  if (config.phoneBackend === "device-mcp")
    return `device-mcp ${deviceMcpVersion(config.deviceMcpExecutable)}`;
  return iphoneUseVersion();
}

/** Changes whenever a setting requires closing and recreating the connection. */
export function phoneConnectionKey(config: RuntimeConfig = getRuntimeConfig()) {
  return JSON.stringify({
    backend: config.phoneBackend,
    iphoneUseRoot: config.iphoneUseRoot,
    iphoneUsePython: config.iphoneUsePython,
    deviceMcpExecutable: config.deviceMcpExecutable,
    deviceMcpDevice: config.deviceMcpDevice,
  });
}
