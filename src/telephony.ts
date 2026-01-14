import type express from "express";
import type { Request } from "express";
import type { CallRecord, CallStatus } from "./types.js";
import type { PluginConfig } from "./config.js";
import { TwilioProvider } from "./providers/twilio.js";
import { MockProvider } from "./providers/mock.js";

export type TelephonyStartResult = {
  providerCallId?: string;
  userHint?: string;
};

export type TelephonyProvider = {
  id: string;
  startCall: (call: CallRecord, baseUrl: string, localBaseUrl: string) => Promise<TelephonyStartResult>;
  endCall?: (call: CallRecord) => Promise<void>;
  buildVoiceResponse: (callId: string, baseUrl: string) => string;
  validateRequest: (req: Request, baseUrl: string) => boolean;
  mapStatus: (payload: any) => CallStatus;
  registerRoutes: (app: express.Express, ctx: TelephonyRouteContext) => void;
};

export type TelephonyRouteContext = {
  config: PluginConfig;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  getLocalBaseUrl: () => string;
};

export function createTelephonyProvider(config: PluginConfig) {
  switch (config.telephony.provider) {
    case "mock":
      return new MockProvider(config);
    case "twilio":
    default:
      return new TwilioProvider(config);
  }
}
