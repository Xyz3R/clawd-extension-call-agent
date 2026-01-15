import { tool } from "@openai/agents";
import {
  OpenAIRealtimeWebSocket,
  RealtimeAgent,
  RealtimeSession,
  backgroundResult,
  type RealtimeSessionConfig,
  type TransportEvent,
  type TransportLayerAudio,
  utils
} from "@openai/agents/realtime";
import type { JsonObjectSchemaNonStrict } from "@openai/agents-core/types";
import type { PluginConfig } from "./config.js";
import type { DebugEvent } from "./debug.js";
import { buildGreetingInstructions, buildPromptContext, buildSessionInstructions } from "./prompting.js";
import type { CallRecord, CallReport } from "./types.js";

const DEBUG_TEXT_ENV = "OPENAI_REALTIME_DEBUG";
const GREETING_TIMEOUT_MS = 8000;

export type RealtimeDeps = {
  config: PluginConfig;
  call: CallRecord;
  onReport?: (call: CallRecord, report: CallReport) => void;
  onSpeechStarted?: () => void;
  onAudioDelta?: (audioBase64: string) => void;
  onLog?: (message: string) => void;
  onDebugEvent?: (event: DebugEvent) => void;
};

type OutputFormat = { type: "audio/pcmu" } | { type: "audio/pcm"; rate: number };
type ToolCallDetails = { toolCall: unknown };

type ReportCallSchema = JsonObjectSchemaNonStrict<{
  summary: { type: "string" };
  outcome: { type: "string"; enum: ["success", "failure", "voicemail", "no_answer", "unknown"] };
  nextSteps: { type: "array"; items: { type: "string" } };
  data: { type: "object"; additionalProperties: true };
}>;

export class OpenAIRealtimeSession {
  private deps: RealtimeDeps;
  private session?: RealtimeSession;
  private closed = false;
  private greetingSent = false;
  private updateSent = false;
  private awaitingSessionUpdated = false;
  private expectedInstructions = "";
  private greetingInstructions = "";
  private outputModalities: ("audio" | "text")[] = ["audio"];
  private outputFormat: OutputFormat = { type: "audio/pcmu" };
  private debugText = false;
  private greetingTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: RealtimeDeps) {
    this.deps = deps;
    this.debugText = isDebugTextEnabled();
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
    void this.start().catch((err) => {
      this.deps.onLog?.(`OpenAI realtime session failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.emitDebug({
        kind: "server",
        message: `OpenAI realtime session failed to start: ${err instanceof Error ? err.message : String(err)}`
      });
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.session?.close();
  }

  sendAudioInput(base64: string): void {
    if (this.closed || !this.session) return;
    if (this.session.transport.status !== "connected") return;
    try {
      const buffer = utils.base64ToArrayBuffer(base64);
      this.session.sendAudio(buffer);
    } catch (err: any) {
      this.deps.onLog?.(`Audio input decode failed: ${err?.message ?? "unknown"}`);
    }
  }

  private async start(): Promise<void> {
    const { call } = this.deps;
    const promptContext = buildPromptContext(call, this.deps.config);
    this.expectedInstructions = buildSessionInstructions(promptContext);
    this.greetingInstructions = buildGreetingInstructions(promptContext);

    const sessionConfig = this.buildSessionConfig();
    const voice = call.request.voice ?? this.deps.config.openai.voice;

    const reportCallSchema: ReportCallSchema = {
      type: "object",
      additionalProperties: true,
      properties: {
        summary: { type: "string" },
        outcome: {
          type: "string",
          enum: ["success", "failure", "voicemail", "no_answer", "unknown"]
        },
        nextSteps: { type: "array", items: { type: "string" } },
        data: { type: "object", additionalProperties: true }
      },
      required: ["summary"]
    };

    const reportCallTool = tool({
      name: "report_call",
      description: "Report call outcome to the system when the call is finished. This will end the call.",
      parameters: reportCallSchema,
      strict: false,
      execute: async (args: any) => {
        const report = normalizeReport(args);
        if (!this.deps.call.report) {
          const now = new Date().toISOString();
          this.deps.call.report = report;
          this.deps.call.completedAt = now;
          this.deps.call.updatedAt = now;
          this.deps.onReport?.(this.deps.call, report);
        }
        return backgroundResult({ ok: true });
      }
    });

    const agent = new RealtimeAgent({
      name: "call-agent",
      instructions: this.expectedInstructions,
      voice,
      tools: [reportCallTool]
    });

    const transport = new OpenAIRealtimeWebSocket({
      useInsecureApiKey: true
    });

    this.session = new RealtimeSession(agent, {
      transport,
      apiKey: this.deps.config.openai.apiKey,
      model: this.deps.config.openai.model,
      config: sessionConfig
    });

    this.attachSessionHandlers(this.session);

    await this.session.connect({
      apiKey: this.deps.config.openai.apiKey,
      model: this.deps.config.openai.model
    });
  }

  private buildSessionConfig(): Partial<RealtimeSessionConfig> {
    const config = this.deps.config.openai;
    const outputModalities: ("audio" | "text")[] = this.debugText ? ["audio", "text"] : ["audio"];
    const inputFormat = this.resolveInputFormat(config);
    const outputFormat = this.resolveOutputFormat(config);
    const transcription = this.debugText ? { model: "gpt-4o-mini-transcribe" } : null;

    this.outputModalities = outputModalities;
    this.outputFormat = outputFormat;

    return {
      toolChoice: "auto",
      outputModalities,
      audio: {
        input: {
          format: inputFormat,
          transcription,
          turnDetection: {
            type: "server_vad",
            createResponse: true,
            interruptResponse: true
          }
        },
        output: {
          format: outputFormat
        }
      }
    };
  }

  private resolveInputFormat(config: PluginConfig["openai"]): { type: "audio/pcmu" } {
    if (config.inputFormat !== "audio/pcmu") {
      this.deps.onLog?.(
        `Input format ${config.inputFormat} does not match Twilio (audio/pcmu). Forcing audio/pcmu.`
      );
    }
    return { type: "audio/pcmu" };
  }

  private resolveOutputFormat(config: PluginConfig["openai"]): OutputFormat {
    if (config.outputFormat === "audio/pcmu") {
      return { type: "audio/pcmu" };
    }

    if (config.outputFormat === "audio/pcma") {
      this.deps.onLog?.("audio/pcma output is not supported for Twilio; using audio/pcmu instead.");
      return { type: "audio/pcmu" };
    }

    if (config.outputSampleRate !== 24000) {
      this.deps.onLog?.(
        `PCM output is fixed at 24000 Hz. Requested ${config.outputSampleRate}; using 24000 Hz.`
      );
    }
    return { type: "audio/pcm", rate: 24000 };
  }

  private attachSessionHandlers(session: RealtimeSession): void {
    session.on("transport_event", (event) => {
      this.handleTransportEvent(event);
    });

    session.on("audio", (event) => {
      this.handleAudio(event);
    });

    session.on("audio_interrupted", () => {
      this.deps.onSpeechStarted?.();
    });

    session.on("agent_tool_start", (_ctx, _agent, toolInstance, details: ToolCallDetails) => {
      const toolCall = parseToolCall(details.toolCall);
      const message = stringifyRealtimePayload({
        tool: toolInstance.name,
        arguments: toolCall?.arguments
      });
      this.emitDebug({
        kind: "tool",
        direction: "in",
        message,
        openaiType: toolInstance.name
      });
    });

    session.on("agent_tool_end", (_ctx, _agent, toolInstance, result, details: ToolCallDetails) => {
      const toolCall = parseToolCall(details.toolCall);
      const message = stringifyRealtimePayload({
        tool: toolInstance.name,
        result,
        callId: toolCall?.callId
      });
      this.emitDebug({
        kind: "tool",
        direction: "out",
        message,
        openaiType: toolInstance.name
      });
    });

    session.on("error", (error) => {
      this.deps.onLog?.(`OpenAI session error: ${String(error?.error ?? error)}`);
      this.emitDebug({
        kind: "server",
        message: `OpenAI session error: ${String(error?.error ?? error)}`
      });
    });
  }

  private handleTransportEvent(event: TransportEvent): void {
    this.logRealtimeMessage("in", event);

    if (event.type === "input_audio_buffer.speech_started") {
      this.deps.onSpeechStarted?.();
      return;
    }

    if (event.type === "session.created") {
      void this.sendSessionUpdate();
      return;
    }

    if (event.type === "session.updated") {
      if (!this.awaitingSessionUpdated) return;
      this.awaitingSessionUpdated = false;

      const appliedInstructions = getSessionInstructions(event);
      if (appliedInstructions && appliedInstructions !== this.expectedInstructions) {
        this.deps.onLog?.("Session instructions mismatch after update. Proceeding with greeting.");
      }

      this.sendGreeting();
      return;
    }
  }

  private async sendSessionUpdate(): Promise<void> {
    if (this.updateSent || !this.session) return;
    this.updateSent = true;
    this.awaitingSessionUpdated = true;
    const config = await this.session.getInitialSessionConfig();
    const payload = {
      type: "session.update",
      session: config
    };
    this.logRealtimeMessage("out", payload);
    this.session.transport.updateSessionConfig(config);
    this.armGreetingTimeout();
  }

  private armGreetingTimeout(): void {
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = setTimeout(() => {
      if (this.greetingSent) return;
      this.deps.onLog?.("Timed out waiting for session.updated; sending greeting anyway.");
      this.sendGreeting();
    }, GREETING_TIMEOUT_MS);
  }

  private sendGreeting(): void {
    if (this.greetingSent || !this.session) return;
    this.greetingSent = true;
    if (this.greetingTimer) clearTimeout(this.greetingTimer);

    const payload = {
      type: "response.create",
      response: {
        instructions: this.greetingInstructions,
        output_modalities: this.outputModalities
      }
    };

    this.logRealtimeMessage("out", payload);
    this.session.transport.sendEvent(payload);
  }

  private handleAudio(event: TransportLayerAudio): void {
    const audio = this.encodeAudio(event.data);
    if (audio) this.deps.onAudioDelta?.(audio);
  }

  private encodeAudio(data: ArrayBuffer): string | null {
    if (this.outputFormat.type === "audio/pcmu") {
      return utils.arrayBufferToBase64(data);
    }

    try {
      const pcm = Buffer.from(data);
      const downsampled = downsamplePcm24To8(pcm);
      const ulaw = encodeMuLaw(downsampled);
      return ulaw.toString("base64");
    } catch (err: any) {
      this.deps.onLog?.(`Audio transcode failed: ${err?.message ?? "unknown"}`);
      return null;
    }
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

function isDebugTextEnabled(): boolean {
  const value = (process.env[DEBUG_TEXT_ENV] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getSessionInstructions(event: any): string | undefined {
  if (typeof event?.session?.instructions === "string") return event.session.instructions;
  if (typeof event?.session?.config?.instructions === "string") return event.session.config.instructions;
  return undefined;
}

function parseToolCall(toolCall: unknown): { arguments?: string; callId?: string } | undefined {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const callId = typeof (toolCall as { callId?: unknown }).callId === "string" ? (toolCall as any).callId : undefined;
  const args =
    typeof (toolCall as { arguments?: unknown }).arguments === "string" ? (toolCall as any).arguments : undefined;
  return callId || args ? { callId, arguments: args } : undefined;
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
