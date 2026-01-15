export type PluginConfig = {
  telephony: {
    provider: "twilio" | "mock";
  };
  server: {
    port: number;
    publicBaseUrl?: string;
  };
  twilio: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    validateSignature: boolean;
  };
  mock?: {
    enabled?: boolean;
  };
  openai: {
    apiKey: string;
    model: string;
    voice: string;
    inputFormat: "audio/pcmu" | "audio/pcma" | "audio/pcm";
    outputFormat: "audio/pcmu" | "audio/pcma" | "audio/pcm";
    outputSampleRate: number;
  };
  notify: {
    hooksUrl?: string;
    hooksToken?: string;
    sessionKey?: string;
  };
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    backoffFactor: number;
    retryStatuses: string[];
  };
  defaults: {
    timezone?: string;
    locale?: string;
  };
  tunnel: {
    provider: "auto" | "ngrok" | "tailscale" | "none";
  };
};

export const defaultConfig: PluginConfig = {
  telephony: {
    provider: "twilio"
  },
  server: {
    port: 4545
  },
  twilio: {
    accountSid: "",
    authToken: "",
    fromNumber: "",
    validateSignature: true
  },
  mock: {},
  openai: {
    apiKey: "",
    model: "gpt-realtime",
    voice: "alloy",
    inputFormat: "audio/pcmu",
    outputFormat: "audio/pcm",
    outputSampleRate: 24000
  },
  notify: {},
  retry: {
    maxAttempts: 3,
    initialDelayMs: 60_000,
    backoffFactor: 2,
    retryStatuses: ["busy", "no_answer", "failed"]
  },
  defaults: {},
  tunnel: {
    provider: "auto"
  }
};

export function parseConfig(raw: Partial<PluginConfig> | undefined): PluginConfig {
  const cfg = structuredClone(defaultConfig);
  if (!raw) return cfg;

  cfg.server = { ...cfg.server, ...raw.server };
  cfg.telephony = { ...cfg.telephony, ...raw.telephony };
  cfg.twilio = { ...cfg.twilio, ...raw.twilio };
  cfg.openai = { ...cfg.openai, ...raw.openai };
  cfg.notify = { ...cfg.notify, ...raw.notify };
  cfg.retry = { ...cfg.retry, ...raw.retry };
  cfg.defaults = { ...cfg.defaults, ...raw.defaults };
  cfg.tunnel = { ...cfg.tunnel, ...raw.tunnel };
  cfg.mock = { ...cfg.mock, ...raw.mock };

  return cfg;
}
