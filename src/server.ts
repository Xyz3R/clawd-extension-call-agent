import http from "node:http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { PluginConfig } from "./config.js";
import { CallManager } from "./call-manager.js";
import { CalendarClient } from "./calendar-client.js";
import { OpenAIRealtimeSession } from "./openai-realtime.js";
import { CallRecord } from "./types.js";
import { ensurePublicUrl, TunnelInfo } from "./tunnel.js";
import type { TelephonyProvider } from "./telephony.js";

export type CallAgentServerDeps = {
  config: PluginConfig;
  callManager: CallManager;
  calendar: CalendarClient;
  telephony: TelephonyProvider;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
};

export class CallAgentServer {
  private deps: CallAgentServerDeps;
  private app = express();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private tunnel?: TunnelInfo;
  private publicBaseUrl?: string;
  private sessions = new Map<string, OpenAIRealtimeSession>();
  private telephony: TelephonyProvider;

  constructor(deps: CallAgentServerDeps) {
    this.deps = deps;
    this.telephony = deps.telephony;
  }

  getPublicBaseUrl(): string {
    if (!this.publicBaseUrl) throw new Error("Public base URL not set");
    return this.publicBaseUrl;
  }

  async start(): Promise<void> {
    this.app.get("/health", (_req, res) => res.json({ ok: true }));

    this.app.post(
      "/voice",
      express.urlencoded({ extended: false }),
      (req, res) => this.handleVoiceRequest(req, res)
    );

    this.app.post(
      "/status",
      express.urlencoded({ extended: false }),
      async (req, res) => {
        if (!this.validateProviderRequest(req)) {
          res.status(401).send("Unauthorized");
          return;
        }

        const callId = String(req.query.callId ?? "");
        const status = this.telephony.mapStatus(req.body ?? {});
        const providerCallId = String(req.body.CallSid ?? req.body.callSid ?? "");
        await this.deps.callManager.handleProviderStatus(callId, status, providerCallId);
        res.sendStatus(200);
      }
    );

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: "/voice/stream" });
    this.wss.on("connection", (socket) => this.handleVoiceStream(socket));

    await new Promise<void>((resolve) => this.server?.listen(this.deps.config.server.port, resolve));

    this.tunnel = await ensurePublicUrl(this.deps.config, this.deps.config.server.port);
    this.publicBaseUrl = this.tunnel.publicUrl ?? this.deps.config.server.publicBaseUrl;
    if (!this.publicBaseUrl && this.deps.config.telephony.provider === "mock") {
      this.publicBaseUrl = `http://127.0.0.1:${this.deps.config.server.port}`;
    }

    if (!this.publicBaseUrl) {
      this.deps.logger.warn("No public URL available. Set server.publicBaseUrl or enable tunnel.");
    } else {
      if (this.publicBaseUrl.startsWith("http://") && this.deps.config.telephony.provider === "twilio") {
        this.deps.logger.warn("publicBaseUrl should be https for Twilio Media Streams.");
      }
      this.deps.logger.info(`Call agent listening at ${this.publicBaseUrl}`);
    }

    this.telephony.registerRoutes(this.app, {
      config: this.deps.config,
      logger: this.deps.logger,
      getLocalBaseUrl: () => `http://127.0.0.1:${this.deps.config.server.port}`
    });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.tunnel?.process?.kill();
  }

  private handleVoiceRequest(req: express.Request, res: express.Response): void {
    if (!this.validateProviderRequest(req)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const callId = String(req.query.callId ?? "");
    const publicUrl = this.publicBaseUrl;
    if (!publicUrl) {
      res.status(500).send("No public URL available");
      return;
    }
    const responseXml = this.telephony.buildVoiceResponse(callId, publicUrl);
    res.type("text/xml").send(responseXml);
  }

  private handleVoiceStream(socket: WebSocket): void {
    socket.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        const callId = msg.start?.customParameters?.callId || "";
        const call = this.deps.callManager.get(callId);
        if (!call) {
          this.deps.logger.warn("voice stream start for unknown call", callId);
          socket.close();
          return;
        }
        this.deps.logger.info("voice stream start", callId);
        call.streamSid = msg.start?.streamSid;
        call.status = "in_progress";

        const session = new OpenAIRealtimeSession({
          config: this.deps.config,
          call,
          calendar: this.deps.calendar,
          onScheduled: (updated) => this.handleScheduled(updated),
          onSpeechStarted: () => {
            if (call.streamSid) {
              socket.send(JSON.stringify({ event: "clear", streamSid: call.streamSid }));
            }
          },
          onAudioDelta: (audio) => {
            if (call.streamSid) {
              socket.send(
                JSON.stringify({
                  event: "media",
                  streamSid: call.streamSid,
                  media: { payload: audio }
                })
              );
            }
          },
          onLog: (text) => this.deps.logger.warn(text)
        });

        this.sessions.set(call.streamSid ?? call.id, session);
        session.connect();
        return;
      }

      if (msg.event === "media") {
        const streamSid = msg.streamSid;
        const session = this.sessions.get(streamSid);
        if (session && msg.media?.payload) {
          session.sendAudioInput(msg.media.payload);
        }
        return;
      }

      if (msg.event === "stop") {
        const streamSid = msg.streamSid;
        const session = this.sessions.get(streamSid);
        session?.close();
        this.sessions.delete(streamSid);
      }
    });
  }

  private async handleScheduled(call: CallRecord): Promise<void> {
    call.status = "completed";
    setTimeout(() => void this.deps.callManager.endCall(call.id), 3000);
    await this.notifyUser(call);
  }

  private async notifyUser(call: CallRecord): Promise<void> {
    const { hooksUrl, hooksToken, sessionKey } = this.deps.config.notify;
    if (!hooksUrl || !hooksToken || !call.scheduledEvent) return;

    const message = [
      `Appointment scheduled with ${call.request.calleeName ?? call.request.to}.`,
      `Time: ${call.scheduledEvent.start} to ${call.scheduledEvent.end} (${call.scheduledEvent.timezone}).`,
      call.scheduledEvent.summary ? `Title: ${call.scheduledEvent.summary}` : ""
    ]
      .filter(Boolean)
      .join(" ");

    try {
      await fetch(`${hooksUrl.replace(/\/$/, "")}/agent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hooksToken}`
        },
        body: JSON.stringify({
          message,
          name: "CallAgent",
          sessionKey,
          wakeMode: "now",
          deliver: true
        })
      });
    } catch (err: any) {
      this.deps.logger.warn(`Failed to notify user: ${err?.message ?? "unknown"}`);
    }
  }

  private validateProviderRequest(req: express.Request): boolean {
    if (!this.publicBaseUrl) return false;
    return this.telephony.validateRequest(req, this.publicBaseUrl);
  }
}
