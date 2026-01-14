import { randomUUID } from "node:crypto";
import type {
  CalendarCheckSlotRequest,
  CalendarCheckSlotResponse,
  CalendarCreateEventRequest,
  CalendarCreateEventResponse,
  CalendarFindSlotsRequest,
  CalendarFindSlotsResponse,
  CalendarSlot,
  CallRecord,
  WorkingHours
} from "./types.js";

type NormalizedSlot = {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
};

const MINUTE_MS = 60_000;
const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export class CalendarEngine {
  private call: CallRecord;

  constructor(call: CallRecord) {
    this.call = call;
    if (!this.call.request.occupiedTimeslots && this.call.request.occupied_timeslots) {
      this.call.request.occupiedTimeslots = this.call.request.occupied_timeslots;
    }
    if (!this.call.request.occupiedTimeslots) {
      this.call.request.occupiedTimeslots = [];
    }
  }

  findSlots(req: CalendarFindSlotsRequest): CalendarFindSlotsResponse {
    const timezone = req.timezone || this.defaultTimezone();
    const windowStartMs = Date.parse(req.windowStart);
    const windowEndMs = Date.parse(req.windowEnd);
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
      return {
        ok: false,
        error: "Invalid scheduling window.",
        slots: [],
        timezone: timezone ?? req.timezone,
        windowStart: req.windowStart,
        windowEnd: req.windowEnd
      };
    }
    const durationMinutes = Math.max(1, req.durationMinutes);
    const durationMs = durationMinutes * MINUTE_MS;
    const granularityMinutes = Math.max(1, req.granularityMinutes ?? durationMinutes);
    const granularityMs = granularityMinutes * MINUTE_MS;
    const occupied = this.getOccupiedSlots();
    const slots: CalendarSlot[] = [];

    for (let t = windowStartMs; t + durationMs <= windowEndMs; t += granularityMs) {
      const slotStartMs = t;
      const slotEndMs = t + durationMs;

      if (!this.isWithinWorkingHours(slotStartMs, slotEndMs, req.workingHours, timezone)) {
        continue;
      }

      if (this.hasConflict(occupied, slotStartMs, slotEndMs, req.bufferBeforeMinutes, req.bufferAfterMinutes)) {
        continue;
      }

      slots.push({
        start: new Date(slotStartMs).toISOString(),
        end: new Date(slotEndMs).toISOString()
      });
    }

    return {
      ok: true,
      timezone: timezone ?? req.timezone,
      slots,
      windowStart: req.windowStart,
      windowEnd: req.windowEnd
    };
  }

  checkSlot(req: CalendarCheckSlotRequest): CalendarCheckSlotResponse {
    const startMs = Date.parse(req.start);
    const endMs = Date.parse(req.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { ok: false, error: "Invalid slot time." };
    }

    const occupied = this.getOccupiedSlots();
    const bufferedStart = startMs - (req.bufferBeforeMinutes ?? 0) * MINUTE_MS;
    const bufferedEnd = endMs + (req.bufferAfterMinutes ?? 0) * MINUTE_MS;
    const conflicts = occupied
      .filter((slot) => overlaps(bufferedStart, bufferedEnd, slot.startMs, slot.endMs))
      .map((slot) => ({ summary: "Busy", start: slot.start, end: slot.end }));

    return { ok: true, conflicts };
  }

  createEvent(req: CalendarCreateEventRequest): CalendarCreateEventResponse {
    const check = this.checkSlot({
      calendarIds: [req.calendarId],
      start: req.start,
      end: req.end,
      timezone: req.timezone
    });
    if (!check.ok) {
      return { ok: false, error: check.error ?? "Unable to validate slot." };
    }
    if (check.conflicts && check.conflicts.length > 0) {
      return { ok: false, error: "Requested slot conflicts with existing events." };
    }

    const eventId = `evt_${randomUUID()}`;
    const newSlot: CalendarSlot = { start: req.start, end: req.end };
    this.call.request.occupiedTimeslots = this.call.request.occupiedTimeslots ?? [];
    this.call.request.occupiedTimeslots.push(newSlot);

    return {
      ok: true,
      eventId,
      calendarId: req.calendarId,
      start: req.start,
      end: req.end,
      timezone: req.timezone
    };
  }

  getOccupiedTimeslots(): CalendarSlot[] {
    return this.call.request.occupiedTimeslots ?? [];
  }

  private getOccupiedSlots(): NormalizedSlot[] {
    const raw = this.call.request.occupiedTimeslots ?? [];
    return raw
      .map((slot) => normalizeSlot(slot))
      .filter((slot): slot is NormalizedSlot => slot !== null)
      .sort((a, b) => a.startMs - b.startMs);
  }

  private defaultTimezone(): string | undefined {
    return this.call.request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private isWithinWorkingHours(
    slotStartMs: number,
    slotEndMs: number,
    workingHours: WorkingHours | undefined,
    timezone?: string
  ): boolean {
    if (!workingHours) return true;
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const startParts = getZonedParts(new Date(slotStartMs), tz);
    const endParts = getZonedParts(new Date(slotEndMs), tz);
    if (!startParts || !endParts) return true;

    if (
      startParts.year !== endParts.year ||
      startParts.month !== endParts.month ||
      startParts.day !== endParts.day
    ) {
      return false;
    }

    if (!workingHours.days.includes(startParts.weekday)) {
      return false;
    }

    const startMinutes = startParts.hour * 60 + startParts.minute;
    const endMinutes = endParts.hour * 60 + endParts.minute;
    const workingStart = parseWorkingMinutes(workingHours.start);
    const workingEnd = parseWorkingMinutes(workingHours.end);
    if (workingStart === null || workingEnd === null) return true;

    return startMinutes >= workingStart && endMinutes <= workingEnd;
  }

  private hasConflict(
    occupied: NormalizedSlot[],
    slotStartMs: number,
    slotEndMs: number,
    bufferBeforeMinutes?: number,
    bufferAfterMinutes?: number
  ): boolean {
    const bufferedStart = slotStartMs - (bufferBeforeMinutes ?? 0) * MINUTE_MS;
    const bufferedEnd = slotEndMs + (bufferAfterMinutes ?? 0) * MINUTE_MS;
    return occupied.some((slot) => overlaps(bufferedStart, bufferedEnd, slot.startMs, slot.endMs));
  }
}

function normalizeSlot(slot: CalendarSlot): NormalizedSlot | null {
  const startMs = Date.parse(slot.start);
  const endMs = Date.parse(slot.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs, start: slot.start, end: slot.end };
}

function parseWorkingMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function getZonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short"
    }).formatToParts(date);

    const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = WEEKDAY_MAP[lookup("weekday")];
    return {
      year: Number(lookup("year")),
      month: Number(lookup("month")),
      day: Number(lookup("day")),
      hour: Number(lookup("hour")),
      minute: Number(lookup("minute")),
      weekday: Number.isFinite(weekday) ? weekday : 0
    };
  } catch {
    return null;
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
