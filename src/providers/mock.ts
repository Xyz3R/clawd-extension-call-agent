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
    body { font-family: system-ui, sans-serif; padding: 24px; max-width: 900px; margin: 0 auto; }
    .row { margin-bottom: 12px; }
    button { padding: 8px 12px; margin-right: 8px; }
    input { padding: 6px 8px; width: 320px; }
    .filters { display: flex; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 12px; }
    .filters label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
    .panel-title { font-weight: 600; margin: 8px 0 6px; }
    .log { background: #0b0f14; color: #cdd9e5; padding: 12px; height: 320px; overflow: auto; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
    .log.tool-log { height: 200px; }
    .log-line { white-space: pre-wrap; }
    .log-openai { color: #8bd5ff; }
    .log-tool { color: #f7c04a; }
    .log-server { color: #9aa4b2; }
    .log-out::before { content: "-> "; color: #64748b; }
    .log-in::before { content: "<- "; color: #64748b; }
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
  <div class="filters">
    <label><input id="filterServer" type="checkbox" checked /> Server</label>
    <label><input id="filterTool" type="checkbox" checked /> Tool calls</label>
    <label><input id="filterSession" type="checkbox" checked /> OpenAI session</label>
    <label><input id="filterResponse" type="checkbox" /> OpenAI response</label>
    <label><input id="filterError" type="checkbox" checked /> OpenAI errors</label>
    <label><input id="filterAudio" type="checkbox" /> OpenAI audio</label>
    <label><input id="filterOther" type="checkbox" /> OpenAI other</label>
    <button id="clearLog" type="button">Clear</button>
    <button id="copyLog" type="button">Copy all</button>
  </div>
  <div class="panel-title">Debug Log</div>
  <div id="log" class="log"></div>
  <div class="panel-title">Tool Calls (AI-triggered)</div>
  <div class="row">
    <button id="clearToolLog" type="button">Clear tool log</button>
    <button id="copyToolLog" type="button">Copy all</button>
  </div>
  <div id="toolLog" class="log tool-log"></div>

<script>
  const baseUrl = ${JSON.stringify(baseUrl)};
  const origin = (location.origin && location.origin !== 'null') ? location.origin : baseUrl;
  const wsBase = origin.replace('http://', 'ws://').replace('https://', 'wss://');
  const callIdInput = document.getElementById('callId');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const toolLogEl = document.getElementById('toolLog');
  const filterServer = document.getElementById('filterServer');
  const filterTool = document.getElementById('filterTool');
  const filterSession = document.getElementById('filterSession');
  const filterResponse = document.getElementById('filterResponse');
  const filterError = document.getElementById('filterError');
  const filterAudio = document.getElementById('filterAudio');
  const filterOther = document.getElementById('filterOther');
  const clearLog = document.getElementById('clearLog');
  const copyLog = document.getElementById('copyLog');
  const clearToolLog = document.getElementById('clearToolLog');
  const copyToolLog = document.getElementById('copyToolLog');
  const params = new URLSearchParams(location.search);
  if (params.get('callId')) callIdInput.value = params.get('callId');

  const logEvents = [];
  const toolEvents = [];
  const MAX_LOGS = 800;
  const MAX_TOOL_LOGS = 200;

  function log(msg) {
    appendEvent({ at: new Date().toISOString(), kind: 'server', message: msg });
  }

  function appendEvent(evt) {
    if (evt.kind === 'openai' && evt.isAudio && !filterAudio.checked) return;
    logEvents.push(evt);
    if (logEvents.length > MAX_LOGS) logEvents.shift();
    if (passesFilters(evt)) {
      appendLine(evt);
    }
    if (evt.kind === 'tool' && evt.direction === 'in') {
      appendToolEvent(evt);
    }
  }

  function appendLine(evt) {
    const line = document.createElement('div');
    line.className = 'log-line log-' + (evt.kind || 'server') + (evt.direction ? ' log-' + evt.direction : '');
    line.textContent = (formatStamp(evt.at) + evt.message);
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderLogs() {
    logEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const evt of logEvents) {
      if (!passesFilters(evt)) continue;
      const line = document.createElement('div');
      line.className = 'log-line log-' + (evt.kind || 'server') + (evt.direction ? ' log-' + evt.direction : '');
      line.textContent = (formatStamp(evt.at) + evt.message);
      frag.appendChild(line);
    }
    logEl.appendChild(frag);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendToolEvent(evt) {
    toolEvents.push(evt);
    if (toolEvents.length > MAX_TOOL_LOGS) toolEvents.shift();
    renderToolLog();
  }

  function renderToolLog() {
    toolLogEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const evt of toolEvents) {
      const line = document.createElement('div');
      line.className = 'log-line log-tool' + (evt.direction ? ' log-' + evt.direction : '');
      const typePrefix = evt.openaiType ? '[' + evt.openaiType + '] ' : '';
      line.textContent = typePrefix + (formatStamp(evt.at) + evt.message);
      frag.appendChild(line);
    }
    toolLogEl.appendChild(frag);
    toolLogEl.scrollTop = toolLogEl.scrollHeight;
  }

  function copyTextFromEvents(events) {
    return events.map((evt) => {
      const prefix = evt.openaiType ? '[' + evt.openaiType + '] ' : '';
      return prefix + (formatStamp(evt.at) + evt.message);
    }).join('\\n');
  }

  async function copyAll(events, label) {
    const text = copyTextFromEvents(events);
    if (!text) {
      log('nothing to copy for ' + label);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      log('copied ' + label + ' (' + events.length + ' lines)');
    } catch (err) {
      log('copy failed: ' + String(err));
    }
  }

  function isAudioEvent(evt) {
    return Boolean(evt.isAudio);
  }

  function passesFilters(evt) {
    if (evt.kind === 'server') return filterServer.checked;
    if (evt.kind === 'tool') return filterTool.checked;
    if (evt.kind === 'openai') {
      if (evt.openaiType === 'error') return filterError.checked;
      if (isAudioEvent(evt)) return filterAudio.checked;
      if (evt.openaiType && evt.openaiType.indexOf('session.') === 0) return filterSession.checked;
      if (evt.openaiType && evt.openaiType.indexOf('response.') === 0) return filterResponse.checked;
      return filterOther.checked;
    }
    return true;
  }

  function formatStamp(iso) {
    if (!iso) return '';
    const time = iso.includes('T') ? iso.split('T')[1].replace('Z', '').split('.')[0] : iso;
    return '[' + time + '] ';
  }

  function connectLogStream() {
    const logWsUrl = wsBase + '/mock/logs';
    log('log stream connecting to ' + logWsUrl);
    const logWs = new WebSocket(logWsUrl);
    logWs.onopen = () => log('log stream connected');
    logWs.onclose = () => {
      log('log stream disconnected');
      setTimeout(connectLogStream, 1000);
    };
    logWs.onerror = () => log('log stream error');
    logWs.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        log(String(event.data));
        return;
      }
      const callIdFilter = callIdInput.value.trim();
      if (callIdFilter && data.callId && data.callId !== callIdFilter) return;
      appendEvent(data);
    };
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
    const wsUrl = wsBase + '/voice/stream';
    log('voice stream connecting to ' + wsUrl);
    ws = new WebSocket(wsUrl);
    ws.onopen = async () => {
      statusEl.textContent = 'connected';
      log('voice stream connected');
      streamSid = crypto.randomUUID();
      ws.send(JSON.stringify({
        event: 'start',
        start: {
          streamSid,
          customParameters: { callId }
        }
      }));
      log('sent start for call ' + callId);

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

    ws.onclose = () => {
      statusEl.textContent = 'closed';
      log('voice stream closed');
    };
    ws.onerror = () => {
      statusEl.textContent = 'error';
      log('voice stream error');
    };
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
  clearLog.onclick = () => { logEvents.length = 0; renderLogs(); };
  clearToolLog.onclick = () => { toolEvents.length = 0; renderToolLog(); };
  copyLog.onclick = () => { void copyAll(logEvents, 'debug log'); };
  copyToolLog.onclick = () => { void copyAll(toolEvents, 'tool log'); };
  const filterInputs = [filterServer, filterTool, filterSession, filterResponse, filterError, filterAudio, filterOther];
  filterInputs.forEach((input) => input.addEventListener('change', renderLogs));
  connectLogStream();

  // Auto-start if a callId is provided in the URL.
  if (params.get('callId')) {
    setTimeout(() => start().catch(err => log(String(err))), 0);
  }
</script>
</body>
</html>`;
}
