import { Type } from "@sinclair/typebox";
import { parseConfig } from "./config.js";
import { CallManager } from "./call-manager.js";
import { CallAgentServer } from "./server.js";
import { CallRequest } from "./types.js";
import { createTelephonyProvider } from "./telephony.js";

const CallAgentInput = Type.Object({
  to: Type.String({ description: "E.164 phone number to call" }),
  goal: Type.String({ description: "Goal of the call" }),
  timezone: Type.Optional(Type.String({ description: "IANA timezone" })),
  durationMinutes: Type.Number({ description: "Desired appointment length in minutes" }),
  windowStart: Type.Optional(Type.String({ description: "RFC3339 start of scheduling window" })),
  windowEnd: Type.Optional(Type.String({ description: "RFC3339 end of scheduling window" })),
  workingHours: Type.Optional(
    Type.Object({
      start: Type.String(),
      end: Type.String(),
      days: Type.Array(Type.Number())
    })
  ),
  calendarId: Type.Optional(Type.String()),
  occupiedTimeslots: Type.Optional(
    Type.Array(
      Type.Object({
        start: Type.String({ description: "RFC3339 start time" }),
        end: Type.String({ description: "RFC3339 end time" })
      })
    )
  ),
  userName: Type.Optional(Type.String()),
  calleeName: Type.Optional(Type.String())
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
      description: "Start a phone call with an AI agent to schedule an appointment.",
      inputSchema: CallAgentInput,
      execute: async (_id: string, params: CallRequest) => {
        const { call, start } = await callManager.startCall(params);
        return {
          content: [
            {
              type: "text",
              text: [
                `Call started (id: ${call.id}). I'll update you when scheduling completes.`,
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
              text: `Status: ${call.status}. Attempts: ${call.attempt}.`
            }
          ],
          data: call
        };
      }
    });
  }
};
