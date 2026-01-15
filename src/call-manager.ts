import { randomUUID } from "node:crypto";
import { CallRecord, CallRequest, CallStatus } from "./types.js";
import { PluginConfig } from "./config.js";
import type { TelephonyProvider, TelephonyStartResult } from "./telephony.js";

export type CallManagerDeps = {
  config: PluginConfig;
  getPublicBaseUrl: () => string;
  getLocalBaseUrl: () => string;
  telephony: TelephonyProvider;
  onStatusChange?: (call: CallRecord) => void;
};

export class CallManager {
  private config: PluginConfig;
  private calls = new Map<string, CallRecord>();
  private getPublicBaseUrl: () => string;
  private getLocalBaseUrl: () => string;
  private telephony: TelephonyProvider;
  private onStatusChange?: (call: CallRecord) => void;

  constructor(deps: CallManagerDeps) {
    this.config = deps.config;
    this.getPublicBaseUrl = deps.getPublicBaseUrl;
    this.getLocalBaseUrl = deps.getLocalBaseUrl;
    this.telephony = deps.telephony;
    this.onStatusChange = deps.onStatusChange;
  }

  list(): CallRecord[] {
    return [...this.calls.values()];
  }

  get(id: string): CallRecord | undefined {
    return this.calls.get(id);
  }

  async startCall(request: CallRequest): Promise<{ call: CallRecord; start: TelephonyStartResult }> {
    const now = new Date().toISOString();
    const call: CallRecord = {
      id: randomUUID(),
      request,
      status: "queued",
      attempt: 0,
      createdAt: now,
      updatedAt: now
    };
    this.calls.set(call.id, call);
    const start = await this.dial(call);
    return { call, start };
  }

  async dial(call: CallRecord): Promise<TelephonyStartResult> {
    call.attempt += 1;
    call.status = "dialing";
    call.updatedAt = new Date().toISOString();
    this.onStatusChange?.(call);

    const base = this.getPublicBaseUrl();
    const localBase = this.getLocalBaseUrl();
    const start = await this.telephony.startCall(call, base, localBase);
    if (start.providerCallId) call.providerCallId = start.providerCallId;
    call.updatedAt = new Date().toISOString();
    this.onStatusChange?.(call);
    return start;
  }

  async handleProviderStatus(callId: string, status: CallStatus, providerCallId?: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;

    call.status = status;
    call.providerCallId = providerCallId || call.providerCallId;
    call.updatedAt = new Date().toISOString();
    this.onStatusChange?.(call);

    if (this.shouldRetry(status, call)) {
      const delay = this.nextDelay(call.attempt);
      setTimeout(() => void this.dial(call), delay);
    }
  }

  private shouldRetry(status: CallStatus, call: CallRecord): boolean {
    if (call.attempt >= this.config.retry.maxAttempts) return false;
    const normalized = normalizeStatus(status);
    return this.config.retry.retryStatuses.map(normalizeStatus).includes(normalized);
  }

  private nextDelay(attempt: number): number {
    const { initialDelayMs, backoffFactor } = this.config.retry;
    return Math.round(initialDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1)));
  }

  async endCall(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    if (this.telephony.endCall) {
      try {
        await this.telephony.endCall(call);
      } catch {
        // ignore
      }
    }
  }
}

function normalizeStatus(value: string): string {
  return value.toLowerCase().replace(/[-\s]/g, "_");
}
