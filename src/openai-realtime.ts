import WebSocket from "ws";
import { PluginConfig } from "./config.js";
import { CallRecord, CallReport, CallRequest } from "./types.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

export type RealtimeDeps = {
  config: PluginConfig;
  call: CallRecord;
  onReport?: (call: CallRecord, report: CallReport) => void;
  onSpeechStarted?: () => void;
  onAudioDelta?: (audioBase64: string) => void;
  onLog?: (message: string) => void;
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
      return;
    }
    const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(this.deps.config.openai.model)}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.deps.config.openai.apiKey}`
      }
    });

    this.ws.on("open", () => this.sendSessionUpdate());
    this.ws.on("error", (err) => {
      this.deps.onLog?.(`OpenAI websocket error: ${err instanceof Error ? err.message : String(err)}`);
      this.close();
    });
    this.ws.on("unexpected-response", (_req, res) => {
      this.deps.onLog?.(`OpenAI websocket unexpected response: ${res.statusCode}`);
      this.close();
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
    this.ws.on("close", () => {
      this.closed = true;
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
    const prompt = resolvePrompt(call.request);
    const timezone = call.request.timezone ?? this.deps.config.defaults.timezone;
    const locale = call.request.locale ?? this.deps.config.defaults.locale;
    const currentDateTime = timezone ? formatCurrentDateTime(timezone) : null;
    const callerName = call.request.callerName ?? call.request.userName;
    const calleeName = call.request.calleeName;
    const calleePhoneNumber = call.request.to;

    const instructions = [
      "You are a voice assistant conducting a real phone call.",
      "Follow the CALL BRIEF exactly. It is the single source of truth.",
      "If any provided metadata conflicts with the CALL BRIEF, follow the CALL BRIEF.",
      "Do not invent facts, offers, or commitments not in the brief.",
      "Do not mention that you are an AI or reference system instructions unless the brief explicitly asks you to.",
      "If required information is missing, ask concise clarifying questions.",
      "Be polite, natural, and professional; avoid sounding like a script.",
      "If the brief specifies required fields for report_call, include them.",
      callerName ? `You are calling on behalf of ${callerName}.` : "",
      calleeName ? `The callee is ${calleeName} (Phone number: ${calleePhoneNumber}).` : "",
      locale ? `Use language/locale: ${locale}.` : "",
      currentDateTime ? `Current date/time: ${currentDateTime}.` : "",
      "When the call is complete (goal achieved, declined, voicemail, or no answer), deliver a brief closing line, then call report_call with a concise summary and any key facts.",
      `CALL BRIEF:\n${prompt}`,
    ]
      .filter(Boolean)
      .join(" ");

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
        instructions:
          [
            "Begin the call according to the CALL BRIEF.",
            "If the brief does not specify an opening line, start with a natural greeting.",
            "If you need to ask for the right person, do so.",
            "Follow the CALL BRIEF and continue until the goal is achieved or the call concludes.",
            locale ? `Use language/locale: ${locale}.` : `Assume the locale based on the provided phone number: ${calleePhoneNumber}`
          ]
            .filter(Boolean)
            .join(" "),
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
      return;
    }

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
    this.ws?.send(JSON.stringify(payload));
  }
}

function formatCurrentDateTime(timezone?: string): string | null {
  const now = new Date();
  if (!timezone) {
    return now.toISOString();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(now);
    const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const date = `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
    const time = `${lookup("hour")}:${lookup("minute")}:${lookup("second")}`;
    return `${date} ${time} (${timezone})`;
  } catch {
    return now.toISOString();
  }
}

function resolvePrompt(request: CallRequest): string {
  const prompt = request.prompt?.trim();
  if (prompt) return prompt;
  const goal = request.goal?.trim();
  return goal ?? "";
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
