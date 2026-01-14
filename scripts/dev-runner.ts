import express from "express";
import { parseConfig } from "../src/config.js";
import { CalendarClient } from "../src/calendar-client.js";
import { CallManager } from "../src/call-manager.js";
import { CallAgentServer } from "../src/server.js";
import { createTelephonyProvider } from "../src/telephony.js";
import type { CallRequest } from "../src/types.js";

const logger = console;

const port = Number(process.env.PORT ?? 4545);
const calendarPort = Number(process.env.CALENDAR_PORT ?? 9100);
const provider = (process.env.TELEPHONY_PROVIDER ?? "mock") as "mock" | "twilio";

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
  calendar: { baseUrl: `http://127.0.0.1:${calendarPort}` },
  defaults: {
    timezone: process.env.DEFAULT_TIMEZONE,
    workingHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }
  },
  tunnel: { provider: "none" }
});

if (!config.openai.apiKey) {
  logger.warn("OPENAI_API_KEY is not set. The realtime session will fail to connect.");
}

const mockCalendar = express();
mockCalendar.use(express.json());
mockCalendar.post("/calendar/find-slots", (_req, res) => {
  res.json({
    ok: true,
    timezone: config.defaults.timezone ?? "America/Los_Angeles",
    windowStart: "2026-01-20T09:00:00-08:00",
    windowEnd: "2026-01-20T17:00:00-08:00",
    slots: [{ start: "2026-01-20T10:00:00-08:00", end: "2026-01-20T10:30:00-08:00" }]
  });
});
mockCalendar.post("/calendar/check-slot", (_req, res) => {
  res.json({ ok: true, conflicts: [] });
});
mockCalendar.post("/calendar/create-event", (_req, res) => {
  res.json({
    ok: true,
    eventId: "evt_mock_1",
    calendarId: "primary",
    start: "2026-01-20T10:00:00-08:00",
    end: "2026-01-20T10:30:00-08:00",
    timezone: config.defaults.timezone ?? "America/Los_Angeles"
  });
});

const calendarServer = mockCalendar.listen(calendarPort, () => {
  logger.info(`Mock calendar listening on http://127.0.0.1:${calendarPort}`);
});

const calendar = new CalendarClient(config);
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
  calendar,
  telephony,
  logger
});

await server.start();
logger.info(`Call agent server up on http://127.0.0.1:${port}`);

if (process.env.AUTO_CALL === "1") {
  const req: CallRequest = {
    to: "+15555555555",
    goal: process.env.CALL_GOAL ?? "Schedule a 30-minute appointment next week.",
    durationMinutes: Number(process.env.CALL_DURATION ?? 30),
    timezone: config.defaults.timezone,
    workingHours: config.defaults.workingHours,
    calendarId: "primary"
  };
  const { call, start } = await callManager.startCall(req);
  logger.info(`Started call ${call.id}. ${start.userHint ?? ""}`);
}

const shutdown = async () => {
  await server.stop();
  calendarServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
