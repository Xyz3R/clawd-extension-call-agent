import WebSocket from "ws";
import { PluginConfig } from "./config.js";
import { DebugEvent } from "./debug.js";
import { buildGreetingInstructions, buildPromptContext, buildSessionInstructions } from "./prompting.js";
import { CallRecord, CallReport } from "./types.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

export type RealtimeDeps = {
  config: PluginConfig;
  call: CallRecord;
  onReport?: (call: CallRecord, report: CallReport) => void;
  onSpeechStarted?: () => void;
  onAudioDelta?: (audioBase64: string) => void;
  onLog?: (message: string) => void;
  onDebugEvent?: (event: DebugEvent) => void;
};

export class OpenAIRealtimeSession {
  private ws?: WebSocket;
  private deps: RealtimeDeps;
  private closed = false;
  private responsePending = false;

  constructor(deps: RealtimeDeps) {
    this.deps = deps;
  }

  connect(): void {
    if (!this.deps.config.openai.apiKey) {
      this.deps.onLog?.("OpenAI API key missing; realtime session not started.");
      this.emitDebug({
        kind: "server",
        message: "OpenAI API key missing; realtime session not started."
      });
      return;
    }
    const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(this.deps.config.openai.model)}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.deps.config.openai.apiKey}`
      }
    });

    this.ws.on("open", () => {
      this.emitDebug({ kind: "server", message: "OpenAI websocket connected." });
      this.sendSessionUpdate();
    });
    this.ws.on("error", (err) => {
      this.deps.onLog?.(`OpenAI websocket error: ${err instanceof Error ? err.message : String(err)}`);
      this.emitDebug({
        kind: "server",
        message: `OpenAI websocket error: ${err instanceof Error ? err.message : String(err)}`
      });
      this.close();
    });
    this.ws.on("unexpected-response", (_req, res) => {
      this.deps.onLog?.(`OpenAI websocket unexpected response: ${res.statusCode}`);
      this.emitDebug({
        kind: "server",
        message: `OpenAI websocket unexpected response: ${res.statusCode}`
      });
      this.close();
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
    this.ws.on("close", () => {
      this.closed = true;
      this.emitDebug({ kind: "server", message: "OpenAI websocket closed." });
    });
  }

  close(): void {
    if (this.closed) return;
    this.ws?.close();
    this.closed = true;
  }

  sendAudioInput(base64: string): void {
    this.send({
      type: "input_audio_buffer.append",
      audio: base64
    });
  }

  private sendSessionUpdate(): void {
    const { call } = this.deps;
    const promptContext = buildPromptContext(call, this.deps.config);
    const instructions = buildSessionInstructions(promptContext);

    const tools = [
      {
        type: "function",
        name: "report_call",
        description: "Report call outcome to the system when the call is finished. This will end the call.",
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {
            summary: { type: "string" },
            outcome: {
              type: "string",
              enum: ["success", "failure", "voicemail", "no_answer", "unknown"]
            },
            nextSteps: { type: "array", items: { type: "string" } },
            data: {
              type: "object",
              additionalProperties: true
            }
          },
          required: ["summary"]
        }
      }
    ];

    const inputFormat =
      this.deps.config.openai.inputFormat === "audio/pcm"
        ? { type: "audio/pcm", rate: 24000 }
        : { type: this.deps.config.openai.inputFormat };
    const outputFormat =
      this.deps.config.openai.outputFormat === "audio/pcm"
        ? { type: "audio/pcm", rate: this.deps.config.openai.outputSampleRate }
        : { type: this.deps.config.openai.outputFormat };

    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        output_modalities: ["audio"],
        tool_choice: "auto",
        tools,
        audio: {
          input: {
            format: inputFormat,
            turn_detection: { type: "server_vad", create_response: true, interrupt_response: true }
          },
          output: {
            format: outputFormat,
            voice: call.request.voice ?? this.deps.config.openai.voice
          }
        }
      }
    });

    // Ask the model to greet and start the conversation.
    this.send({
      type: "response.create",
      response: {
        instructions: buildGreetingInstructions(promptContext),
        output_modalities: ["audio"]
      }
    });
    this.responsePending = true;
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.emitDebug({ kind: "server", direction: "in", message: "OpenAI websocket received invalid JSON." });
      return;
    }
    this.logRealtimeMessage("in", msg);

    if (msg.type === "input_audio_buffer.speech_started") {
      this.deps.onSpeechStarted?.();
      return;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      if (!this.responsePending) {
        this.responsePending = true;
        this.send({ type: "response.create", response: { output_modalities: ["audio"] } });
      }
      return;
    }

    if ((msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") && msg.delta) {
      const audio = this.maybeTranscodeAudio(msg.delta);
      if (audio) this.deps.onAudioDelta?.(audio);
      return;
    }

    if (
      msg.type === "response.completed" ||
      msg.type === "response.done" ||
      msg.type === "response.output_audio.done" ||
      msg.type === "response.audio.done"
    ) {
      this.responsePending = false;
      return;
    }

    if (
      msg.type === "response.function_call_arguments.done" ||
      msg.type === "response.tool_call_arguments.done"
    ) {
      await this.handleToolCall(msg);
      return;
    }

    if (msg.type === "error" && msg.error?.message) {
      this.deps.onLog?.(`OpenAI error: ${msg.error.message}`);
      this.emitDebug({ kind: "server", message: `OpenAI error: ${msg.error.message}` });
    }
  }

  private async handleToolCall(msg: any): Promise<void> {
    const name = (msg.name ?? msg.tool_name) as string;
    const callId = (msg.call_id ?? msg.id) as string;
    let args: any = {};
    try {
      args = JSON.parse(msg.arguments ?? "{}");
    } catch {
      args = {};
    }

    let result: unknown;
    try {
      if (name === "report_call") {
        const report = normalizeReport(args);
        if (!this.deps.call.report) {
          const now = new Date().toISOString();
          this.deps.call.report = report;
          this.deps.call.completedAt = now;
          this.deps.call.updatedAt = now;
          this.deps.onReport?.(this.deps.call, report);
        }
        result = { ok: true };
      } else {
        result = { ok: false, error: `Unknown tool: ${name}` };
      }
    } catch (err: any) {
      result = { ok: false, error: err?.message ?? "Tool error" };
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result)
      }
    });

    if (name !== "report_call") {
      this.send({ type: "response.create" });
    }
  }

  private maybeTranscodeAudio(base64: string): string | null {
    if (this.deps.config.openai.outputFormat === "audio/pcmu") {
      return base64;
    }

    try {
      const pcm = Buffer.from(base64, "base64");
      const downsampled = downsamplePcm24To8(pcm);
      const ulaw = encodeMuLaw(downsampled);
      return ulaw.toString("base64");
    } catch (err: any) {
      this.deps.onLog?.(`Audio transcode failed: ${err?.message ?? "unknown"}`);
      return null;
    }
  }

  private send(payload: unknown): void {
    if (this.closed) return;
    this.logRealtimeMessage("out", payload);
    this.ws?.send(JSON.stringify(payload));
  }

  private emitDebug(event: Omit<DebugEvent, "at" | "callId"> & { callId?: string }): void {
    this.deps.onDebugEvent?.({
      at: new Date().toISOString(),
      callId: event.callId ?? this.deps.call.id,
      ...event
    });
  }

  private logRealtimeMessage(direction: "in" | "out", payload: any): void {
    if (payload?.type === "input_audio_buffer.append") return;
    const kind = isToolPayload(payload) ? "tool" : "openai";
    const openaiType = typeof payload?.type === "string" ? payload.type : undefined;
    const isAudio = isAudioPayload(openaiType);
    const message = stringifyRealtimePayload(payload);
    this.emitDebug({
      kind,
      direction,
      message,
      openaiType,
      isAudio
    });
  }
}

function stringifyRealtimePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, (key, value) => {
      if (typeof value === "string") {
        if (key === "audio" || key === "delta" || key === "payload") {
          return `[base64 ${value.length} chars]`;
        }
        if (value.length > 500) {
          return `${value.slice(0, 500)}...(${value.length} chars)`;
        }
      }
      return value;
    });
  } catch {
    return String(payload);
  }
}

function isToolPayload(payload: any): boolean {
  const type = typeof payload?.type === "string" ? payload.type : "";
  if (type.includes("function_call") || type.includes("tool_call")) return true;
  if (type === "conversation.item.create" && payload?.item?.type === "function_call_output") return true;
  return false;
}

function isAudioPayload(type?: string): boolean {
  if (!type) return false;
  if (type.includes("audio.delta") || type.includes("output_audio") || type.includes("audio.done")) return true;
  return false;
}

function normalizeReport(args: any): CallReport {
  const summary = typeof args?.summary === "string" && args.summary.trim() ? args.summary.trim() : "No summary provided.";
  const outcome =
    typeof args?.outcome === "string" &&
    ["success", "failure", "voicemail", "no_answer", "unknown"].includes(args.outcome)
      ? (args.outcome as CallReport["outcome"])
      : "unknown";
  const nextSteps = Array.isArray(args?.nextSteps)
    ? args.nextSteps.filter((step: any) => typeof step === "string" && step.trim()).map((step: string) => step.trim())
    : undefined;
  const data =
    args?.data && typeof args.data === "object" && !Array.isArray(args.data)
      ? (args.data as Record<string, unknown>)
      : extractReportData(args);

  return {
    summary,
    outcome,
    nextSteps,
    data
  };
}

function extractReportData(args: any): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const { summary, outcome, nextSteps, data, ...rest } = args;
  const keys = Object.keys(rest);
  if (!keys.length) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const key of keys) {
    cleaned[key] = rest[key];
  }
  return cleaned;
}

function downsamplePcm24To8(buf: Buffer): Buffer {
  // Input: 16-bit little-endian PCM @ 24kHz. Output: 16-bit PCM @ 8kHz.
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const outLen = Math.floor(samples.length / 3);
  const out = new Int16Array(outLen);
  let j = 0;
  for (let i = 0; i < samples.length - 2; i += 3) {
    out[j++] = samples[i];
  }
  return Buffer.from(out.buffer);
}

function encodeMuLaw(buf: Buffer): Buffer {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = linearToMuLawSample(samples[i]);
  }
  return out;
}

function linearToMuLawSample(sample: number): number {
  const MU_LAW_MAX = 0x1fff;
  const BIAS = 0x84;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
