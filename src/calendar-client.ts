import {
  CalendarCheckSlotRequest,
  CalendarCheckSlotResponse,
  CalendarCreateEventRequest,
  CalendarCreateEventResponse,
  CalendarFindSlotsRequest,
  CalendarFindSlotsResponse
} from "./types.js";
import { PluginConfig } from "./config.js";

export class CalendarClient {
  private baseUrl: string;
  private token?: string;

  constructor(config: PluginConfig) {
    this.baseUrl = config.calendar.baseUrl.replace(/\/$/, "");
    this.token = config.calendar.token;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendar bridge error ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  findSlots(req: CalendarFindSlotsRequest): Promise<CalendarFindSlotsResponse> {
    return this.post("/calendar/find-slots", req);
  }

  checkSlot(req: CalendarCheckSlotRequest): Promise<CalendarCheckSlotResponse> {
    return this.post("/calendar/check-slot", req);
  }

  createEvent(req: CalendarCreateEventRequest): Promise<CalendarCreateEventResponse> {
    return this.post("/calendar/create-event", req);
  }
}
