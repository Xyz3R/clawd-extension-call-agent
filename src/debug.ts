export type DebugEvent = {
  at: string;
  kind: "openai" | "tool" | "server";
  direction?: "in" | "out";
  callId?: string;
  message: string;
  openaiType?: string;
  isAudio?: boolean;
};
