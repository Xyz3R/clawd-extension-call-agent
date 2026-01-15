import http from "node:http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { PluginConfig } from "./config.js";
import { CallManager } from "./call-manager.js";
import { DebugEvent } from "./debug.js";
import { OpenAIRealtimeSession } from "./openai-realtime.js";
import { transcodePcm24ToPcmu8 } from "./audio.js";
import { CallRecord, CallReport } from "./types.js";
import { ensurePublicUrl, TunnelInfo } from "./tunnel.js";
import type { TelephonyProvider } from "./telephony.js";

export type CallAgentServerDeps = {
  config: PluginConfig;
  callManager: CallManager;
  telephony: TelephonyProvider;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
};

export class CallAgentServer {
  private deps: CallAgentServerDeps;
  private app = express();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private logWss?: WebSocketServer;
  private tunnel?: TunnelInfo;
  private publicBaseUrl?: string;
  private sessions = new Map<string, OpenAIRealtimeSession>();
  private logClients = new Set<WebSocket>();
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
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket) => this.handleVoiceStream(socket));
    this.logWss = new WebSocketServer({ noServer: true });
    this.logWss.on("connection", (socket) => this.handleLogStream(socket));
    this.logWss.on("error", (err) => {
      this.deps.logger.warn(`log stream websocket error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.server.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname === "/voice/stream") {
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit("connection", ws, req);
        });
        return;
      }
      if (pathname === "/mock/logs") {
        this.logWss?.handleUpgrade(req, socket, head, (ws) => {
          this.logWss?.emit("connection", ws, req);
        });
        return;
      }
      socket.destroy();
    });

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
    this.wss?.close();
    this.logWss?.close();
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
    this.emitDebug({ kind: "server", message: "Voice stream websocket connected." });
    socket.on("close", () => {
      this.emitDebug({ kind: "server", message: "Voice stream websocket closed." });
    });
    socket.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        this.emitDebug({
          kind: "server",
          direction: "in",
          message: "Voice stream received invalid JSON."
        });
        return;
      }

      if (msg.event === "start") {
        const callId = msg.start?.customParameters?.callId || "";
        const call = this.deps.callManager.get(callId);
        if (!call) {
          this.deps.logger.warn("voice stream start for unknown call", callId);
          this.emitDebug({
            kind: "server",
            callId,
            message: `Voice stream start for unknown call ${callId || "(missing callId)"}.`
          });
          socket.close();
          return;
        }
        this.deps.logger.info("voice stream start", callId);
        this.emitDebug({
          kind: "server",
          callId,
          message: "Voice stream start received."
        });
        call.streamSid = msg.start?.streamSid;
        call.status = "in_progress";

        const session = new OpenAIRealtimeSession({
          config: this.deps.config,
          call,
          onReport: (updated, report) => void this.handleReport(updated, report),
          onSpeechStarted: () => {
            if (call.streamSid) {
              socket.send(JSON.stringify({ event: "clear", streamSid: call.streamSid }));
            }
          },
          onAudioDelta: (audio, format) => {
            if (!call.streamSid) return;
            try {
              const payload =
                format.type === "audio/pcmu"
                  ? Buffer.from(audio).toString("base64")
                  : transcodePcm24ToPcmu8(Buffer.from(audio)).toString("base64");
              socket.send(
                JSON.stringify({
                  event: "media",
                  streamSid: call.streamSid,
                  media: { payload }
                })
              );
            } catch (err) {
              const message = `Twilio audio transcode failed: ${err instanceof Error ? err.message : String(err)}`;
              this.deps.logger.warn(message);
              this.emitDebug({ kind: "server", callId, message });
            }
          },
          onLog: (text) => {
            this.deps.logger.warn(text);
            this.emitDebug({ kind: "server", callId, message: text });
          },
          onDebugEvent: (event) => this.emitDebug(event)
        });

        this.sessions.set(call.streamSid ?? call.id, session);
        session.connect();
        this.emitDebug({ kind: "server", callId, message: "OpenAI realtime session connecting." });
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
        this.emitDebug({ kind: "server", message: `Voice stream stopped (${streamSid}).` });
      }
    });
  }

  private handleLogStream(socket: WebSocket): void {
    this.logClients.add(socket);
    socket.on("close", () => this.logClients.delete(socket));
  }

  private emitDebug(event: Omit<DebugEvent, "at">): void {
    const payload = JSON.stringify({ at: new Date().toISOString(), ...event });
    for (const socket of this.logClients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        this.logClients.delete(socket);
      }
    }
  }

  private async handleReport(call: CallRecord, report: CallReport): Promise<void> {
    if (!call.completedAt) {
      const now = new Date().toISOString();
      call.status = "completed";
      call.completedAt = now;
      call.updatedAt = now;
    }
    setTimeout(() => void this.deps.callManager.endCall(call.id), 2500);
    await this.notifyUser(call, report);
  }

  private async notifyUser(call: CallRecord, report?: CallReport): Promise<void> {
    const { hooksUrl, hooksToken, sessionKey } = this.deps.config.notify;
    if (!hooksUrl || !hooksToken) return;

    const summary = report?.summary ?? call.report?.summary;
    const outcome = report?.outcome ?? call.report?.outcome ?? call.status;
    const message = [
      `Call completed with ${call.request.calleeName ?? call.request.to}.`,
      outcome ? `Outcome: ${outcome}.` : "",
      summary ? `Summary: ${summary}` : ""
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
          deliver: true,
          data: {
            callId: call.id,
            status: call.status,
            to: call.request.to,
            calleeName: call.request.calleeName,
            report: report ?? call.report ?? null,
            metadata: call.request.metadata ?? null
          }
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
