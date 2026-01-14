export type WorkingHours = {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
  days: number[]; // 0=Sun..6=Sat
};

export type CallRequest = {
  to: string;
  goal: string;
  timezone?: string;
  durationMinutes: number;
  windowStart?: string; // RFC3339
  windowEnd?: string;   // RFC3339
  workingHours?: WorkingHours;
  calendarId?: string;
  userName?: string;
  calleeName?: string;
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
  scheduledEvent?: {
    eventId: string;
    calendarId: string;
    start: string;
    end: string;
    timezone: string;
    summary?: string;
  };
};

export type CalendarSlot = {
  start: string;
  end: string;
};

export type CalendarFindSlotsRequest = {
  calendarIds: string[];
  windowStart: string;
  windowEnd: string;
  durationMinutes: number;
  timezone: string;
  granularityMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  workingHours?: WorkingHours;
  attendees?: { email: string; optional?: boolean }[];
};

export type CalendarCheckSlotRequest = {
  calendarIds: string[];
  start: string;
  end: string;
  timezone: string;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
};

export type CalendarCreateEventRequest = {
  calendarId: string;
  start: string;
  end: string;
  timezone: string;
  title: string;
  description?: string;
  location?: string;
  attendees?: { email: string; optional?: boolean }[];
  idempotencyKey: string;
};

export type CalendarFindSlotsResponse = {
  ok: boolean;
  timezone: string;
  slots: CalendarSlot[];
  windowStart: string;
  windowEnd: string;
  error?: string;
};

export type CalendarCheckSlotResponse = {
  ok: boolean;
  conflicts?: { summary: string; start: string; end: string }[];
  alternatives?: CalendarSlot[];
  error?: string;
};

export type CalendarCreateEventResponse = {
  ok: boolean;
  eventId?: string;
  calendarId?: string;
  start?: string;
  end?: string;
  timezone?: string;
  error?: string;
};
