import type express from "express";
import type { Request } from "express";
import { PluginConfig } from "../config.js";
import type { CallRecord, CallStatus } from "../types.js";
import type { TelephonyProvider, TelephonyRouteContext, TelephonyStartResult } from "../telephony.js";

export class MockProvider implements TelephonyProvider {
  id = "mock";
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async startCall(call: CallRecord, _baseUrl: string, localBaseUrl: string): Promise<TelephonyStartResult> {
    const url = `${localBaseUrl}/mock?callId=${encodeURIComponent(call.id)}`;
    return {
      userHint: `Open ${url} to start the mock call.`
    };
  }

  buildVoiceResponse(callId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Mock call ${callId}</Say></Response>`;
  }

  validateRequest(_req: Request): boolean {
    return true;
  }

  mapStatus(): CallStatus {
    return "in_progress";
  }

  registerRoutes(app: express.Express, ctx: TelephonyRouteContext): void {
    app.get("/mock", (_req, res) => {
      res.type("text/html").send(buildMockHtml(ctx.getLocalBaseUrl()));
    });
  }
}

function buildMockHtml(baseUrl: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Call Agent Mock</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 24px; max-width: 720px; margin: 0 auto; }
    .row { margin-bottom: 12px; }
    button { padding: 8px 12px; margin-right: 8px; }
    input { padding: 6px 8px; width: 320px; }
    pre { background: #111; color: #0f0; padding: 12px; height: 220px; overflow: auto; }
  </style>
</head>
<body>
  <h1>Mock Call Agent</h1>
  <div class="row">
    <label>Call ID: </label>
    <input id="callId" />
  </div>
  <div class="row">
    <button id="start">Start</button>
    <button id="stop">Stop</button>
  </div>
  <div class="row">WS: <span id="status">disconnected</span></div>
  <pre id="log"></pre>

<script>
  const baseUrl = ${JSON.stringify(baseUrl)};
  const callIdInput = document.getElementById('callId');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const params = new URLSearchParams(location.search);
  if (params.get('callId')) callIdInput.value = params.get('callId');

  function log(msg) {
    logEl.textContent += msg + "\\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  let ws;
  let audioCtx;
  let processor;
  let sourceNode;
  let inputStream;
  let streamSid;
  let playHead = 0;
  const activeNodes = new Set();
  let silenceGain;

  function muLawEncodeSample(sample) {
    const MU_LAW_MAX = 0x1fff;
    const BIAS = 0x84;
    let sign = 0;
    if (sample < 0) { sign = 0x80; sample = -sample; }
    if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent -= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  function muLawDecodeSample(u) {
    u = ~u & 0xff;
    const sign = (u & 0x80) ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const sample = ((mantissa << 3) + 0x84) << exponent;
    return sign * (sample - 0x84);
  }

  function downsampleTo8k(input, inputRate) {
    const ratio = inputRate / 8000;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = input[Math.floor(i * ratio)] * 0x7fff;
    }
    return out;
  }

  function upsampleFrom8k(input, outputRate) {
    const ratio = outputRate / 8000;
    const outLen = Math.floor(input.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIndex = Math.min(input.length - 1, Math.floor(i / ratio));
      out[i] = input[srcIndex] / 0x7fff;
    }
    return out;
  }

  async function start() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const callId = callIdInput.value.trim();
    if (!callId) { alert('Enter call id'); return; }
    const wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/voice/stream';
    ws = new WebSocket(wsUrl);
    ws.onopen = async () => {
      statusEl.textContent = 'connected';
      streamSid = crypto.randomUUID();
      ws.send(JSON.stringify({
        event: 'start',
        start: {
          streamSid,
          customParameters: { callId }
        }
      }));

      audioCtx = new AudioContext();
      inputStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      sourceNode = audioCtx.createMediaStreamSource(inputStream);

      const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (event) => {
        if (!ws || ws.readyState !== 1) return;
        const input = event.inputBuffer.getChannelData(0);
        const down = downsampleTo8k(input, audioCtx.sampleRate);
        const ulaw = new Uint8Array(down.length);
        for (let i = 0; i < down.length; i++) ulaw[i] = muLawEncodeSample(down[i]);
        const payload = btoa(String.fromCharCode(...ulaw));
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload }
        }));
      };

      sourceNode.connect(scriptNode);
      silenceGain = audioCtx.createGain();
      silenceGain.gain.value = 0;
      scriptNode.connect(silenceGain);
      silenceGain.connect(audioCtx.destination);
      processor = scriptNode;
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.event === 'media' && msg.media?.payload) {
        const bin = atob(msg.media.payload);
        const ulaw = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) ulaw[i] = bin.charCodeAt(i);
        const pcm = new Int16Array(ulaw.length);
        for (let i = 0; i < ulaw.length; i++) pcm[i] = muLawDecodeSample(ulaw[i]);
        const floatSamples = upsampleFrom8k(pcm, audioCtx.sampleRate);
        const buffer = audioCtx.createBuffer(1, floatSamples.length, audioCtx.sampleRate);
        buffer.getChannelData(0).set(floatSamples);
        const node = audioCtx.createBufferSource();
        node.buffer = buffer;
        node.connect(audioCtx.destination);
        const startAt = Math.max(audioCtx.currentTime, playHead);
        node.start(startAt);
        playHead = startAt + buffer.duration;
        activeNodes.add(node);
        node.onended = () => activeNodes.delete(node);
      }
      if (msg.event === 'clear') {
        for (const node of activeNodes) {
          try { node.stop(); } catch {}
        }
        activeNodes.clear();
        playHead = audioCtx.currentTime;
      }
    };

    ws.onclose = () => { statusEl.textContent = 'closed'; };
    ws.onerror = () => { statusEl.textContent = 'error'; };
  }

  async function stop() {
    if (ws && ws.readyState === 1 && streamSid) {
      ws.send(JSON.stringify({ event: 'stop', streamSid }));
      ws.close();
    }
    for (const node of activeNodes) {
      try { node.stop(); } catch {}
    }
    activeNodes.clear();
    if (processor) processor.disconnect();
    if (silenceGain) silenceGain.disconnect();
    if (sourceNode) sourceNode.disconnect();
    if (inputStream) inputStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    ws = null;
    processor = null;
    sourceNode = null;
    inputStream = null;
    silenceGain = null;
    playHead = 0;
  }

  document.getElementById('start').onclick = () => start().catch(err => log(String(err)));
  document.getElementById('stop').onclick = () => stop();

  // Auto-start if a callId is provided in the URL.
  if (params.get('callId')) {
    setTimeout(() => start().catch(err => log(String(err))), 0);
  }
</script>
</body>
</html>`;
}
