import { Type } from "@sinclair/typebox";
import { parseConfig } from "./config.js";
import { CallManager } from "./call-manager.js";
import { CallAgentServer } from "./server.js";
import { resolvePrompt } from "./prompting.js";
import { CallRequest } from "./types.js";
import { createTelephonyProvider } from "./telephony.js";

const CallAgentInput = Type.Object({
  to: Type.String({ description: "E.164 phone number to call" }),
  prompt: Type.Optional(Type.String({ description: "Detailed call brief with all necessary context and instructions" })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone for current date/time context" })),
  locale: Type.Optional(Type.String({ description: "BCP-47 language tag (e.g., en-US)" })),
  callerName: Type.Optional(Type.String({ description: "Name of the person or org you are calling on behalf of" })),
  calleeName: Type.Optional(Type.String({ description: "Name of the person you are calling" })),
  voice: Type.Optional(Type.String({ description: "Override the OpenAI voice for this call" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any()))
});

const CallAgentStatusInput = Type.Object({
  callId: Type.String()
});

export default {
  id: "clawdbot-call-agent",
  name: "Call Agent",
  configSchema: {
    parse: (raw: any) => parseConfig(raw)
  },
  async register(api: any) {
    const config = parseConfig(api?.config ?? {});
    const logger = api?.logger ?? console;

    const telephony = createTelephonyProvider(config);
    let server!: CallAgentServer;
    const callManager = new CallManager({
      config,
      telephony,
      getPublicBaseUrl: () => server.getPublicBaseUrl(),
      getLocalBaseUrl: () => `http://127.0.0.1:${config.server.port}`,
      onStatusChange: (call) => logger.info("call status", call.id, call.status)
    });
    server = new CallAgentServer({
      config,
      callManager,
      telephony,
      logger
    });

    api.registerService({
      id: "call-agent-server",
      start: () => server.start(),
      stop: () => server.stop()
    });

    api.registerTool({
      name: "call_agent",
      description: "Start a phone call with an AI agent following a provided prompt.",
      inputSchema: CallAgentInput,
      execute: async (_id: string, params: CallRequest) => {
        const prompt = resolvePrompt(params);
        if (!prompt) {
          return {
            content: [
              {
                type: "text",
                text: "Missing prompt. Provide `prompt`."
              }
            ]
          };
        }
        const request: CallRequest = { ...params, prompt };
        const { call, start } = await callManager.startCall(request);
        return {
          content: [
            {
              type: "text",
              text: [
                `Call started (id: ${call.id}). Check status with call_agent_status.`,
                start.userHint ?? ""
              ]
                .filter(Boolean)
                .join(" ")
            }
          ],
          data: { callId: call.id }
        };
      }
    });

    api.registerTool({
      name: "call_agent_status",
      description: "Check status of a call-agent job by id.",
      inputSchema: CallAgentStatusInput,
      execute: async (_id: string, params: { callId: string }) => {
        const call = callManager.get(params.callId);
        if (!call) {
          return { content: [{ type: "text", text: "Call not found." }] };
        }
        return {
          content: [
            {
              type: "text",
              text: [
                `Status: ${call.status}. Attempts: ${call.attempt}.`,
                call.report?.summary ? `Summary: ${call.report.summary}` : ""
              ]
                .filter(Boolean)
                .join(" ")
            }
          ],
          data: call
        };
      }
    });
  }
};
