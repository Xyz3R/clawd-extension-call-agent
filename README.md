# Clawdbot Call Agent (Twilio + OpenAI Realtime)

This plugin adds a `call_agent` tool that places a phone call via Twilio Media Streams, runs a realtime voice agent through OpenAI Realtime, and schedules an appointment by calling a calendar bridge.

## Install

```bash
# from GitHub
clawdbot plugins install https://github.com/<you>/clawdbot-call-agent
```

Or load via `plugins.load.paths` and point at `src/index.ts`.

## Configuration

```json
{
  "telephony": {
    "provider": "twilio"
  },
  "server": {
    "port": 4545,
    "publicBaseUrl": "https://<public-host>"
  },
  "twilio": {
    "accountSid": "AC...",
    "authToken": "...",
    "fromNumber": "+15551234567",
    "validateSignature": true
  },
  "openai": {
    "apiKey": "sk-...",
    "model": "gpt-4o-realtime-preview",
    "voice": "alloy",
    "inputFormat": "audio/pcmu",
    "outputFormat": "audio/pcm",
    "outputSampleRate": 24000
  },
  "calendar": {
    "baseUrl": "http://127.0.0.1:9100",
    "token": "optional"
  },
  "notify": {
    "hooksUrl": "http://127.0.0.1:19000/hooks",
    "hooksToken": "...",
    "sessionKey": "optional"
  },
  "defaults": {
    "timezone": "America/Los_Angeles",
    "workingHours": { "start": "09:00", "end": "17:00", "days": [1,2,3,4,5] }
  },
  "retry": {
    "maxAttempts": 3,
    "initialDelayMs": 60000,
    "backoffFactor": 2,
    "retryStatuses": ["busy", "no-answer", "failed"]
  },
  "tunnel": {
    "provider": "auto"
  }
}
```

If `publicBaseUrl` is not provided, the plugin attempts to open a tunnel via `tailscale funnel` or `ngrok`.

### Mock provider (local dev)

Set `"telephony.provider": "mock"` to fake a phone call from your local mic/speakers. Start a call with `call_agent` and open the provided mock URL in your browser to talk to the agent.

## Telephony provider interface (for adding new vendors)

Implement `TelephonyProvider` in `src/telephony.ts` and register it in `createTelephonyProvider`.

Required responsibilities:
- `startCall(call, publicBaseUrl, localBaseUrl)` — initiate a call and return `{ providerCallId?, userHint? }`
- `buildVoiceResponse(callId, publicBaseUrl)` — return provider-specific XML/response to connect the call to `/voice/stream`
- `validateRequest(req, publicBaseUrl)` — validate inbound webhook signatures (or return `true`)
- `mapStatus(payload)` — map provider webhook payload to `CallStatus`
- `registerRoutes(app, ctx)` — add provider-specific routes if needed (optional but required by interface)
- `endCall(call)` — optional hangup

Expected HTTP endpoints:
- `POST /voice` — provider webhooks request this; should return connect XML to `/voice/stream`.
- `POST /status` — provider status callback; should map status via `mapStatus`.
- `WS /voice/stream` — bidirectional audio stream. For non-Twilio providers, implement a bridge that speaks Twilio-style Media Streams events (see mock provider for example).

## LLM ingestion (contract summary)

Purpose: Provide a Clawdbot plugin that places calls via a telephony provider, runs a realtime voice agent, and schedules appointments without calendar conflicts.

Tools:
- `call_agent` — starts a call. Inputs: `to`, `goal`, `durationMinutes`, optional `timezone`, `windowStart`, `windowEnd`, `workingHours`, `calendarId`, `userName`, `calleeName`. Output includes `callId` and a hint URL when `telephony.provider = "mock"`.
- `call_agent_status` — returns status for a `callId`.

Calendar bridge (provider-agnostic):
- `POST /calendar/find-slots`
- `POST /calendar/check-slot`
- `POST /calendar/create-event`
Payloads match `src/types.ts`. Responses must include `{ ok: true }` for success.

Call flow:
1) `call_agent` creates a call job and starts the provider.
2) Provider hits `POST /voice` → plugin returns connect response to `/voice/stream`.
3) `/voice/stream` streams mu-law audio between provider and OpenAI Realtime.
4) Realtime model calls calendar tools via the HTTP bridge.
5) On `calendar_create_event` success, plugin notifies user via `/hooks/agent` (if configured) and ends the call.

Config keys:
- `telephony.provider`: `twilio | mock`
- `server.port`, `server.publicBaseUrl`
- `twilio.*` (when using Twilio)
- `openai.*` (Realtime model/voice/audio format)
- `calendar.baseUrl` (+ optional token)
- `notify.hooksUrl`, `notify.hooksToken`, `notify.sessionKey`
- `defaults.timezone`, `defaults.workingHours`
- `retry.*`, `tunnel.provider`

## Calendar bridge contract

The plugin does not manage providers directly. It calls a local calendar bridge that Clawdbot (or another service) implements:

- `POST /calendar/find-slots`
- `POST /calendar/check-slot`
- `POST /calendar/create-event`

Payloads match the tool schemas in `src/types.ts`. Responses should include `{ ok: true }` and relevant data.

## Tools

- `call_agent` — start a phone call to schedule an appointment.
- `call_agent_status` — check call status by id.

## Notes

- Twilio Media Streams expects G.711 mu-law audio at 8kHz. The plugin tries to configure OpenAI Realtime to match.
- The mock provider uses a browser audio loopback and sends Twilio-compatible stream events to the server.
- If Realtime output is PCM, audio is downsampled and μ-law encoded before sending to Twilio.
