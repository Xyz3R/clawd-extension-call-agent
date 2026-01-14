import { parseConfig } from "../src/config.js";
import { CallManager } from "../src/call-manager.js";
import { CallAgentServer } from "../src/server.js";
import { createTelephonyProvider } from "../src/telephony.js";
import type { CallRequest } from "../src/types.js";

const logger = console;

const port = Number(process.env.PORT ?? 4545);
const provider = (process.env.TELEPHONY_PROVIDER ?? "mock") as "mock" | "twilio";
const fallbackTimezone = process.env.DEFAULT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const config = parseConfig({
  telephony: { provider },
  server: { port, publicBaseUrl: process.env.PUBLIC_BASE_URL },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-realtime-preview",
    voice: process.env.OPENAI_VOICE ?? "alloy",
    inputFormat:
      (process.env.OPENAI_INPUT_FORMAT as "audio/pcmu" | "audio/pcma" | "audio/pcm") ?? "audio/pcmu",
    outputFormat:
      (process.env.OPENAI_OUTPUT_FORMAT as "audio/pcmu" | "audio/pcma" | "audio/pcm") ?? "audio/pcm",
    outputSampleRate: Number(process.env.OPENAI_OUTPUT_RATE ?? 24000)
  },
  defaults: {
    timezone: fallbackTimezone,
    workingHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }
  },
  tunnel: { provider: "none" }
});

if (!config.openai.apiKey) {
  logger.warn("OPENAI_API_KEY is not set. The realtime session will fail to connect.");
}

const telephony = createTelephonyProvider(config);
let server!: CallAgentServer;
const callManager = new CallManager({
  config,
  telephony,
  getPublicBaseUrl: () => server.getPublicBaseUrl(),
  getLocalBaseUrl: () => `http://127.0.0.1:${port}`,
  onStatusChange: (call) => logger.info("call status", call.id, call.status)
});

server = new CallAgentServer({
  config,
  callManager,
  telephony,
  logger
});

await server.start();
logger.info(`Call agent server up on http://127.0.0.1:${port}`);

if (process.env.AUTO_CALL === "1") {
  const now = new Date();
  const { windowStart, windowEnd, occupiedTimeslots } = buildTodayTestSchedule(now);
  const todayWorkingHours = { ...config.defaults.workingHours, days: [now.getDay()] };
  const req: CallRequest = {
    to: "+15555555555",
    goal: process.env.CALL_GOAL ?? "Schedule a 30-minute appointment today.",
    durationMinutes: 30,
    timezone: config.defaults.timezone,
    workingHours: todayWorkingHours,
    calendarId: "primary",
    windowStart,
    windowEnd,
    occupiedTimeslots
  };
  const { call, start } = await callManager.startCall(req);
  logger.info(`Started call ${call.id}. ${start.userHint ?? ""}`);
}

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function buildTodayTestSchedule(baseDate: Date): {
  windowStart: string;
  windowEnd: string;
  occupiedTimeslots: { start: string; end: string }[];
} {
  const base = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 9, 0, 0, 0);
  const windowStart = base.toISOString();
  const windowEnd = new Date(base.getTime() + 3 * 60 * 60 * 1000).toISOString();

  return {
    windowStart,
    windowEnd,
    occupiedTimeslots: [
      slot(base, 30, 60),
      slot(base, 90, 120),
      slot(base, 150, 180)
    ]
  };
}

function slot(base: Date, startOffsetMinutes: number, endOffsetMinutes: number): { start: string; end: string } {
  const start = new Date(base.getTime() + startOffsetMinutes * 60_000).toISOString();
  const end = new Date(base.getTime() + endOffsetMinutes * 60_000).toISOString();
  return { start, end };
}
