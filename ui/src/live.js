// Real-time voice with the Gemini Live API, through the Jarvis service (which holds the key).
// Microphone → 16 kHz PCM → service → Gemini; Gemini → 24 kHz PCM → speakers, with interruption,
// transcripts for the overlay, and a timed audio level the face reads for lip-sync.

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

class LiveVoice extends EventTarget {
  state = 'off'; // off | connecting | listening | thinking | speaking | error
  ws = null;
  micCtx = null;
  micStream = null;
  micNode = null;
  outCtx = null;
  playhead = 0;
  sources = new Set();
  timeline = []; // scheduled playback segments with their loudness, for the face
  speech = []; // recent transcript fragments, for mouth shapes
  transcript = { user: '', jarvis: '' };
  lines = [];
  micLevel = 0;
  message = '';

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  get active() {
    return this.state !== 'off' && this.state !== 'error';
  }

  async start({ orgId = null } = {}) {
    if (this.active) return;
    this.lines = [];
    this.transcript = { user: '', jarvis: '' };
    this.message = '';
    this.setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/voice/live${orgId ? `?org=${orgId}` : ''}`);
    } catch (err) {
      return this.fail(err.message);
    }
    this.ws = ws;
    ws.onopen = () => this.openAudio().catch((err) => this.fail(err?.message || 'Microphone unavailable'));
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => this.fail('Could not connect to the Jarvis voice service.');
    ws.onclose = () => {
      if (this.state !== 'error' && this.state !== 'off') this.stop();
    };
  }

  fail(message) {
    this.message = message;
    this.teardown();
    this.setState('error', { message });
  }

  async openAudio() {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.micCtx = new AudioContext({ sampleRate: 16000 });
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    const node = this.micCtx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const f = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(f.length);
      let sum = 0;
      for (let i = 0; i < f.length; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      this.micLevel = Math.sqrt(sum / f.length);
      this.ws.send(JSON.stringify({ type: 'audio', data: b64(pcm.buffer) }));
    };
    const mute = this.micCtx.createGain();
    mute.gain.value = 0; // the processor needs a destination, but the microphone must not be heard
    source.connect(node);
    node.connect(mute);
    mute.connect(this.micCtx.destination);
    this.micNode = node;
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    this.playhead = 0;
  }

  onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.setupComplete) return this.setState('listening');
    if (m.jarvis) {
      if (m.jarvis.error) return this.fail(m.jarvis.message || 'Voice error');
      if (m.jarvis.tool && m.jarvis.result === undefined) {
        this.setState('thinking');
        this.emit('tool', m.jarvis);
      } else if (m.jarvis.result !== undefined) this.setState(this.playing ? 'speaking' : 'listening');
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      this.flush();
      this.setState('listening');
    }
    if (sc.inputTranscription?.text) {
      this.transcript.user += sc.inputTranscription.text;
      this.emit('transcript', { who: 'you', text: this.transcript.user });
    }
    if (sc.outputTranscription?.text) {
      this.transcript.jarvis += sc.outputTranscription.text;
      this.speech.push({ at: performance.now(), text: sc.outputTranscription.text });
      if (this.speech.length > 200) this.speech.splice(0, 100);
      this.emit('transcript', { who: 'jarvis', text: this.transcript.jarvis });
    }
    for (const part of sc.modelTurn?.parts ?? []) if (part.inlineData?.data) this.play(part.inlineData.data);
    if (sc.turnComplete) this.commitLines();
  }

  commitLines() {
    if (this.transcript.user.trim()) this.lines.push({ who: 'you', text: this.transcript.user.trim() });
    if (this.transcript.jarvis.trim()) this.lines.push({ who: 'jarvis', text: this.transcript.jarvis.trim() });
    this.transcript = { user: '', jarvis: '' };
    this.emit('lines', this.lines.slice(-8));
  }

  play(data) {
    if (!this.outCtx) return;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    if (!pcm.length) return;
    const buf = this.outCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      ch[i] = pcm[i] / 0x8000;
      sum += ch[i] * ch[i];
    }
    const level = Math.sqrt(sum / pcm.length);
    const t0 = Math.max(this.outCtx.currentTime + 0.03, this.playhead);
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    src.start(t0);
    this.playhead = t0 + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size && this.state === 'speaking') this.setState('listening');
    };
    this.timeline.push({ t0, t1: this.playhead, level });
    if (this.timeline.length > 600) this.timeline.splice(0, 300);
    this.setState('speaking');
  }

  flush() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already finished
      }
    }
    this.sources.clear();
    this.playhead = 0;
    this.timeline = [];
  }

  get playing() {
    return Boolean(this.outCtx) && this.playhead > this.outCtx.currentTime;
  }

  // Loudness of what is playing right now (0..1), for the face and the waveform.
  level() {
    if (!this.outCtx) return 0;
    const t = this.outCtx.currentTime;
    const seg = this.timeline.find((s) => t >= s.t0 && t < s.t1);
    return seg ? Math.min(1, seg.level * 4) : 0;
  }

  // Transcript text spoken in the last few hundred milliseconds (approximate; the transcript arrives near the audio).
  recentSpeech(ms = 400) {
    const t = performance.now();
    return this.speech
      .filter((s) => t - s.at < ms)
      .map((s) => s.text)
      .join('');
  }

  sendText(text) {
    if (!this.ws || this.ws.readyState !== 1 || !String(text).trim()) return false;
    this.ws.send(JSON.stringify({ type: 'text', text: String(text) }));
    this.lines.push({ who: 'you', text: String(text).trim() });
    this.emit('lines', this.lines.slice(-8));
    this.setState('thinking');
    return true;
  }

  stop() {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ type: 'end' }));
      } catch {
        // closing anyway
      }
    }
    this.teardown();
    this.setState('off');
  }

  teardown() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.flush();
    try {
      this.micNode?.disconnect();
    } catch {
      // ignore
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close().catch(() => {});
    this.outCtx?.close().catch(() => {});
    this.micCtx = this.outCtx = this.micStream = this.micNode = null;
  }
}

export const live = new LiveVoice();
