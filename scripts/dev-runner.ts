import dotenv from "dotenv";
import { parseConfig } from "../src/config.js";
import { CallManager } from "../src/call-manager.js";
import { CallAgentServer } from "../src/server.js";
import { createTelephonyProvider } from "../src/telephony.js";
import type { CallRequest } from "../src/types.js";

const logger = console;

dotenv.config();

const port = Number(process.env.PORT ?? 4545);
const provider = (process.env.TELEPHONY_PROVIDER ?? "mock") as "mock" | "twilio";
const fallbackTimezone = process.env.DEFAULT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const config = parseConfig({
  telephony: { provider },
  server: { port, publicBaseUrl: process.env.PUBLIC_BASE_URL },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-realtime",
    voice: process.env.OPENAI_VOICE ?? "alloy",
    inputFormat:
      (process.env.OPENAI_INPUT_FORMAT as "audio/pcmu" | "audio/pcma" | "audio/pcm") ?? "audio/pcmu",
    outputFormat:
      (process.env.OPENAI_OUTPUT_FORMAT as "audio/pcmu" | "audio/pcma" | "audio/pcm") ?? "audio/pcm",
    outputSampleRate: Number(process.env.OPENAI_OUTPUT_RATE ?? 24000)
  },
  defaults: {
    timezone: fallbackTimezone
  },
  tunnel: { provider: "none" }
});

if (!config.openai.apiKey) {
  logger.warn("OPENAI_API_KEY is not set. The realtime session will fail to connect.");
}

const callPrompt =
  process.env.CALL_GOAL ??
  "Call the business, ask for their current hours, and confirm whether walk-ins are accepted today. Be polite and concise.";

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
logger.info(`Call Goal: ${callPrompt}`);

if (process.env.AUTO_CALL === "1") {
  const req: CallRequest = {
    to: "+4915781231232",
    prompt: callPrompt,
    timezone: config.defaults.timezone,
    callerName: "Felix Mennen",
    // locale: "de",
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
console.log(`Prompt: ${process.env.CALL_GOAL ?? ""}`);
