export type CallRequest = {
  to: string;
  prompt?: string;
  timezone?: string;
  locale?: string;
  callerName?: string;
  calleeName?: string;
  voice?: string;
  metadata?: Record<string, unknown>;
};

export type CallReport = {
  summary: string;
  outcome?: "success" | "failure" | "voicemail" | "no_answer" | "unknown";
  nextSteps?: string[];
  data?: Record<string, unknown>;
};

export type CallStatus =
  | "queued"
  | "dialing"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "canceled";

export type CallRecord = {
  id: string;
  request: CallRequest;
  status: CallStatus;
  attempt: number;
  providerCallId?: string;
  streamSid?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  report?: CallReport;
};
