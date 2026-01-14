import WebSocket from "ws";
import { PluginConfig } from "./config.js";
import { CalendarCheckSlotRequest, CalendarCreateEventRequest, CalendarFindSlotsRequest, CallRecord } from "./types.js";
import { CalendarEngine } from "./calendar-engine.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

export type RealtimeDeps = {
  config: PluginConfig;
  call: CallRecord;
  onScheduled: (call: CallRecord) => void;
  onSpeechStarted?: () => void;
  onAudioDelta?: (audioBase64: string) => void;
  onLog?: (message: string) => void;
};

export class OpenAIRealtimeSession {
  private ws?: WebSocket;
  private deps: RealtimeDeps;
  private closed = false;
  private responsePending = false;
  private calendar: CalendarEngine;

  constructor(deps: RealtimeDeps) {
    this.deps = deps;
    this.calendar = new CalendarEngine(deps.call);
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
    const timezone = call.request.timezone ?? this.deps.config.defaults.timezone ?? "";
    const workingHours = call.request.workingHours ?? this.deps.config.defaults.workingHours;
    const calendarId = call.request.calendarId ?? "primary";
    const currentDateTime = formatCurrentDateTime(timezone);
    const occupiedSlotsText = formatOccupiedSlots(this.calendar.getOccupiedTimeslots());
    const callerName = call.request.userName ?? "the user";
    const calleeName = call.request.calleeName ?? "the callee";

    const instructions = [
      `You are the personal assistant working on behalf of the ${call.request.userName}.`,
      "Always begin the call by greeting the callee.",
      `Immediately after greeting, say you are calling on behalf of ${callerName} to ${calleeName} and state the purpose: ${call.request.goal}.`,
      "Then continue the conversation to reach the scheduling goal.",
      "Treat the provided call goal as the single source of truth. Do not change the purpose (e.g., do not turn it into a follow-up) unless the goal explicitly says so.",
      "You must confirm a specific date/time with the callee before creating an event.",
      "Always check availability with calendar_check_slot before confirming.",
      "If unavailable, use calendar_find_slots to propose alternatives.",
      "When the callee confirms, call calendar_create_event immediately.",
      "After calendar_create_event succeeds, confirm the appointment and politely end the call.",
      "Use the occupied calendar slots provided as the source of truth for availability.",
      "Do not schedule outside business hours.",
      "Respected the occupied slots. They are non negotiably occupied.",
      `Business hours: ${workingHours.start}-${workingHours.end} on days ${workingHours.days.join(",")}.`,
      timezone ? `Timezone: ${timezone}.` : "",
      currentDateTime ? `Current date/time: ${currentDateTime}.` : "",
      occupiedSlotsText ? `Occupied calendar slots: ${occupiedSlotsText}.` : "",
      call.request.windowStart && call.request.windowEnd
        ? `Scheduling window: ${call.request.windowStart} to ${call.request.windowEnd}.`
        : "",
      `Use calendar IDs: ${calendarId}.`,
      call.request.goal ? `Call goal: ${call.request.goal}` : ""
    ]
      .filter(Boolean)
      .join(" ");

    const tools = [
      {
        type: "function",
        name: "calendar_find_slots",
        description: "Find available time slots that satisfy business hours and duration, based on occupied slots.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            calendarIds: { type: "array", items: { type: "string" } },
            windowStart: { type: "string" },
            windowEnd: { type: "string" },
            durationMinutes: { type: "number" },
            timezone: { type: "string" },
            granularityMinutes: { type: "number" },
            bufferBeforeMinutes: { type: "number" },
            bufferAfterMinutes: { type: "number" },
            workingHours: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: "string" },
                days: { type: "array", items: { type: "number" } }
              },
              required: ["start", "end", "days"]
            }
          },
          required: ["calendarIds", "windowStart", "windowEnd", "durationMinutes", "timezone"]
        }
      },
      {
        type: "function",
        name: "calendar_check_slot",
        description: "Check if a proposed slot conflicts with the occupied calendar slots.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            calendarIds: { type: "array", items: { type: "string" } },
            start: { type: "string" },
            end: { type: "string" },
            timezone: { type: "string" },
            bufferBeforeMinutes: { type: "number" },
            bufferAfterMinutes: { type: "number" }
          },
          required: ["calendarIds", "start", "end", "timezone"]
        }
      },
      {
        type: "function",
        name: "calendar_create_event",
        description: "Create (record) a calendar event after the callee confirms the time.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            calendarId: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            timezone: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
            attendees: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  optional: { type: "boolean" }
                },
                required: ["email"]
              }
            },
            idempotencyKey: { type: "string" }
          },
          required: ["calendarId", "start", "end", "timezone", "title", "idempotencyKey"]
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
            voice: this.deps.config.openai.voice
          }
        }
      }
    });

    // Ask the model to greet and start the conversation in English.
    this.send({
      type: "response.create",
      response: {
        instructions:
          [
            "Greet the callee, state who you are calling for and the exact goal, then continue the conversation to reach that goal.",
            call.request.goal ? `Use this goal verbatim: ${call.request.goal}.` : "",
            "Use English only"
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

    const defaultCalendarId = this.deps.call.request.calendarId ?? "primary";
    const defaultTimezone = this.deps.call.request.timezone ?? this.deps.config.defaults.timezone;
    const defaultWorkingHours = this.deps.call.request.workingHours ?? this.deps.config.defaults.workingHours;
    if (!args.calendarIds && (name === "calendar_find_slots" || name === "calendar_check_slot")) {
      args.calendarIds = [defaultCalendarId];
    }
    if (!args.calendarId && name === "calendar_create_event") {
      args.calendarId = defaultCalendarId;
    }
    if (!args.timezone && defaultTimezone) {
      args.timezone = defaultTimezone;
    }
    if (!args.workingHours && name === "calendar_find_slots" && defaultWorkingHours) {
      args.workingHours = defaultWorkingHours;
    }

    let result: unknown;
    try {
      if (name === "calendar_find_slots") {
        result = this.calendar.findSlots(args as CalendarFindSlotsRequest);
      } else if (name === "calendar_check_slot") {
        result = this.calendar.checkSlot(args as CalendarCheckSlotRequest);
      } else if (name === "calendar_create_event") {
        const created = this.calendar.createEvent(args as CalendarCreateEventRequest);
        result = created;
        if (created.ok && created.eventId && created.start && created.end && created.timezone) {
          this.deps.call.scheduledEvent = {
            eventId: created.eventId,
            calendarId: created.calendarId ?? args.calendarId,
            start: created.start,
            end: created.end,
            timezone: created.timezone,
            summary: args.title
          };
          this.deps.onScheduled(this.deps.call);
        }
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

    this.send({ type: "response.create" });
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

function formatOccupiedSlots(slots: { start: string; end: string }[]): string | null {
  if (!slots.length) return "none";
  return slots.map((slot) => `${slot.start} to ${slot.end}`).join("; ");
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
