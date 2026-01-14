import twilio from "twilio";
import type express from "express";
import type { Request } from "express";
import { PluginConfig } from "../config.js";
import type { CallRecord, CallStatus } from "../types.js";
import type { TelephonyProvider, TelephonyRouteContext, TelephonyStartResult } from "../telephony.js";

export class TwilioProvider implements TelephonyProvider {
  id = "twilio";
  private config: PluginConfig;
  private client: ReturnType<typeof twilio>;

  constructor(config: PluginConfig) {
    this.config = config;
    this.client = twilio(this.config.twilio.accountSid, this.config.twilio.authToken);
  }

  async startCall(call: CallRecord, baseUrl: string): Promise<TelephonyStartResult> {
    const voiceUrl = `${baseUrl}/voice?provider=twilio&callId=${encodeURIComponent(call.id)}`;
    const statusUrl = `${baseUrl}/status?provider=twilio&callId=${encodeURIComponent(call.id)}`;

    const twCall = await this.client.calls.create({
      to: call.request.to,
      from: this.config.twilio.fromNumber,
      url: voiceUrl,
      statusCallback: statusUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST"
    });

    return { providerCallId: twCall.sid };
  }

  async endCall(call: CallRecord): Promise<void> {
    if (!call.providerCallId) return;
    await this.client.calls(call.providerCallId).update({ status: "completed" });
  }

  buildVoiceResponse(callId: string, baseUrl: string): string {
    const wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const voiceResponse = new twilio.twiml.VoiceResponse();
    const connect = voiceResponse.connect();
    const stream = connect.stream({ url: `${wsUrl}/voice/stream` });
    stream.parameter({ name: "callId", value: callId });
    return voiceResponse.toString();
  }

  validateRequest(req: Request, baseUrl: string): boolean {
    if (!this.config.twilio.validateSignature) return true;
    const signature = req.header("x-twilio-signature") || "";
    const url = `${baseUrl}${req.originalUrl}`;
    return twilio.validateRequest(this.config.twilio.authToken, signature, url, req.body ?? {});
  }

  mapStatus(payload: any): CallStatus {
    const status = String(payload?.CallStatus ?? "");
    switch (status) {
      case "queued":
      case "ringing":
      case "in-progress":
        return "in_progress";
      case "completed":
        return "completed";
      case "busy":
        return "busy";
      case "no-answer":
        return "no_answer";
      case "failed":
        return "failed";
      case "canceled":
        return "canceled";
      default:
        return "failed";
    }
  }

  registerRoutes(_app: express.Express, _ctx: TelephonyRouteContext): void {
    // No extra routes for Twilio.
  }
}
