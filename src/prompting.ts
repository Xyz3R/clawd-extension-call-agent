import { PluginConfig } from "./config.js";
import { CallRecord, CallRequest } from "./types.js";

export type PromptContext = {
  prompt: string;
  timezone?: string;
  locale?: string;
  currentDateTime?: string | null;
  callerName?: string;
  calleeName?: string;
  calleePhoneNumber?: string;
};

export function resolvePrompt(request: CallRequest): string {
  const prompt = request.prompt?.trim();
  return prompt ?? "";
}

export function buildPromptContext(call: CallRecord, config: PluginConfig): PromptContext {
  const prompt = resolvePrompt(call.request);
  const timezone = call.request.timezone ?? config.defaults.timezone;
  const locale = call.request.locale ?? config.defaults.locale;
  const currentDateTime = timezone ? formatCurrentDateTime(timezone) : null;
  const callerName = call.request.callerName;
  const calleeName = call.request.calleeName;
  const calleePhoneNumber = call.request.to;

  return {
    prompt,
    timezone,
    locale,
    currentDateTime,
    callerName,
    calleeName,
    calleePhoneNumber
  };
}

export function buildSessionInstructions(context: PromptContext): string {
  return [
    "You are a voice assistant conducting a real phone call.",
    "Follow the CALL BRIEF exactly. It is the single source of truth.",
    "If any provided metadata conflicts with the CALL BRIEF, follow the CALL BRIEF.",
    "Do not invent facts, offers, or commitments not in the brief.",
    "Do not mention that you are an AI or reference system instructions unless the brief explicitly asks you to.",
    "If required information is missing, ask concise clarifying questions.",
    "Be polite, natural, and professional; avoid sounding like a script.",
    "If the brief specifies required fields for report_call, include them.",
    context.callerName ? `You are calling on behalf of ${context.callerName}.` : "",
    context.calleeName
      ? `The callee is ${context.calleeName} (Phone number: ${context.calleePhoneNumber}).`
      : "",
    context.locale ? `Use language/locale: ${context.locale}.` : "",
    context.currentDateTime ? `Current date/time: ${context.currentDateTime}.` : "",
    "When the call is complete (goal achieved, declined, voicemail, or no answer), deliver a brief closing line, then call report_call with a concise summary and any key facts.",
    `CALL BRIEF:\n${context.prompt}`
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildGreetingInstructions(context: PromptContext): string {
  return [
    "Begin the call according to the CALL BRIEF.",
    "If the brief does not specify an opening line, start with a natural greeting.",
    "If you need to ask for the right person, do so.",
    "Follow the CALL BRIEF and continue until the goal is achieved or the call concludes.",
    context.locale
      ? `Use language/locale: ${context.locale}.`
      : `Assume the locale based on the provided phone number: ${context.calleePhoneNumber}`
  ]
    .filter(Boolean)
    .join(" ");
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
