// The speech engine (~6 MB of WebAssembly) loads only when voice is switched on.

// Offline voice for Jarvis. Speech recognition runs locally (Vosk, WebAssembly): a small grammar
// listens only for the wake word "Jarvis"; after it (or Ctrl+Space) a full recogniser captures the
// command. Nothing is sent anywhere until the command text goes to the local Jarvis service.
// Replies are spoken with the Windows voices through the Web Speech synthesis API.

const MODEL_URL = () => `${location.origin}/api/voice/model.tar.gz`;
const COMMAND_TIMEOUT_MS = 9000;

class Voice extends EventTarget {
  state = 'off'; // off | loading | listening | command | speaking | error
  model = null;
  ctx = null;
  stream = null;
  mode = 'wake';
  wakeEnabled = true;

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  async start({ wake = true } = {}) {
    this.wakeEnabled = wake;
    if (this.model) return;
    try {
      this.setState('loading');
      const { createModel } = await import('vosk-browser');
      this.model = await createModel(MODEL_URL(), -1);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      this.ctx = new AudioContext();
      const rate = this.ctx.sampleRate;
      this.wake = new this.model.KaldiRecognizer(rate, JSON.stringify(['jarvis', 'hey jarvis', '[unk]']));
      this.wake.on('result', (m) => this.onWake(m.result.text));
      this.command = new this.model.KaldiRecognizer(rate);
      this.command.on('partialresult', (m) => this.mode === 'command' && m.result.partial && this.emit('partial', m.result.partial));
      this.command.on('result', (m) => this.onCommand(m.result.text));
      const source = this.ctx.createMediaStreamSource(this.stream);
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (this.state === 'speaking') return; // don't transcribe our own voice
        try {
          if (this.mode === 'command') this.command.acceptWaveform(e.inputBuffer);
          else if (this.wakeEnabled) this.wake.acceptWaveform(e.inputBuffer);
        } catch {
          // recogniser busy; drop this chunk
        }
      };
      source.connect(node);
      node.connect(this.ctx.destination);
      this.setState('listening');
    } catch (err) {
      this.model = null;
      this.setState('error', { message: err?.message || 'Microphone or speech model unavailable' });
    }
  }

  onWake(text) {
    if (this.mode !== 'wake' || !/\bjarvis\b/i.test(text)) return;
    this.emit('wake');
    this.listenForCommand();
  }

  // Also used by Ctrl+Space and the mic button.
  listenForCommand() {
    if (!this.model) return false;
    this.mode = 'command';
    this.setState('command');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.command?.retrieveFinalResult(), COMMAND_TIMEOUT_MS);
    return true;
  }

  onCommand(text) {
    if (this.mode !== 'command') return;
    const clean = String(text || '').replace(/^\s*(hey\s+)?jarvis[,\s]*/i, '').trim();
    if (!clean) return; // silence so far; keep listening until the timeout
    clearTimeout(this.timer);
    this.mode = 'wake';
    this.setState('listening');
    this.emit('command', clean);
  }

  cancelCommand() {
    clearTimeout(this.timer);
    this.mode = 'wake';
    if (this.model) this.setState('listening');
  }

  speak(text) {
    if (!('speechSynthesis' in window) || !text) return Promise.resolve();
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      u.voice =
        voices.find((v) => /Guy|Ryan|David|Mark/i.test(v.name) && /en-(GB|US)/i.test(v.lang)) ??
        voices.find((v) => /^en/i.test(v.lang)) ??
        null;
      u.rate = 1.03;
      const prev = this.state;
      u.onstart = () => this.setState('speaking');
      u.onend = u.onerror = () => {
        this.setState(this.model ? 'listening' : prev === 'speaking' ? 'off' : prev);
        resolve();
      };
      speechSynthesis.speak(u);
    });
  }

  stop() {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.model?.terminate();
    this.model = this.ctx = this.stream = null;
    this.mode = 'wake';
    this.setState('off');
  }
}

export const voice = new Voice();
