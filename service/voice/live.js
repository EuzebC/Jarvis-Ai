// Real-time voice: the HUD streams the microphone to this endpoint, which relays it to the Gemini Live
// API and streams the spoken answer back. The Gemini key never leaves the service. The voice model is
// only the mouth and ears: anything about the organisation goes through the ask_jarvis tool, which is
// answered by Jarvis's own brain (Claude) with the full conversation memory.
import { WebSocketServer } from 'ws';
import { one, getSetting } from '../db.js';
import { log } from '../events.js';
import * as auth from '../auth.js';
import { chat } from '../brain/chat.js';
import { situation } from '../brain/operator.js';

const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const DEFAULT_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
export const DEFAULT_VOICE = 'Charon';
export const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
export const liveConfigured = () => Boolean(getSetting('gemini_api_key'));

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'ask_jarvis',
        description:
          'Hands a request to Jarvis’s main brain, which knows the organisation in depth, creates missions, checks the CRM, the outbox, the agents, and remembers the whole conversation. Use it for anything about the organisation, its work, numbers, people or plans, and for every instruction. Returns the answer to speak.',
        parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'The owner’s request, complete and in their own words' } }, required: ['request'] },
      },
      {
        name: 'organisation_status',
        description: 'A quick factual snapshot of the current organisation: goals, missions running, outbox, leads, connectors. Fast; use it for "what is happening" and "how are we doing".',
        parameters: { type: 'OBJECT', properties: {} },
      },
    ],
  },
];

function systemInstruction(orgId) {
  const org = orgId ? one('SELECT name, description FROM orgs WHERE id = ?', orgId) : null;
  const owner = getSetting('owner_profile', '').trim();
  return [
    `You are Jarvis, the voice of an AI system that runs ${org ? `the organisation "${org.name}"${org.description ? ` (${org.description})` : ''}` : "the owner's personal workspace"} for its owner.`,
    'Speak like a calm, sharp chief of staff: short sentences, natural spoken language, no lists, no markdown, no emojis. Answer in the language the owner speaks to you.',
    'You know only what the tools tell you. For anything about the organisation, its work, numbers, people, plans, and for every instruction, call ask_jarvis with the owner’s request and speak its answer, shortened for speech. For "what is happening" use organisation_status.',
    'Say one short sentence before a tool call when it may take a moment (for example "Let me check."). Never invent facts, names or numbers.',
    owner ? `About the owner: ${owner.slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));

export function attachLiveVoice(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/voice/live') return socket.destroy();
    const token = cookies(req).jarvis_session || url.searchParams.get('token');
    if (!auth.validSession(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, { orgId: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null }));
  });
}

function session(client, { orgId }) {
  const sendClient = (obj) => client.readyState === client.OPEN && client.send(JSON.stringify(obj));
  const key = getSetting('gemini_api_key');
  if (!key) {
    sendClient({ jarvis: { error: 'no_key', message: 'Add a Gemini API key in Settings → Voice first.' } });
    return client.close();
  }
  const model = getSetting('gemini_live_model', DEFAULT_LIVE_MODEL);
  const voiceName = getSetting('gemini_voice', DEFAULT_VOICE);
  const scope = { orgId };
  let upstream;
  try {
    upstream = new WebSocket(`${GEMINI_WS}?key=${encodeURIComponent(key)}`);
  } catch (err) {
    sendClient({ jarvis: { error: 'connect', message: err.message } });
    return client.close();
  }
  upstream.binaryType = 'arraybuffer';
  let closed = false;
  const closeAll = (reason) => {
    if (closed) return;
    closed = true;
    try {
      upstream.close();
    } catch {}
    try {
      client.close();
    } catch {}
    if (reason) log('info', `Voice session ended: ${reason}`, orgId);
  };

  upstream.addEventListener('open', () => {
    upstream.send(
      JSON.stringify({
        setup: {
          model,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          systemInstruction: { parts: [{ text: systemInstruction(orgId) }] },
          tools: TOOLS,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }),
    );
    log('info', `Voice session started (${model.replace(/^models\//, '')}, ${voiceName})`, orgId);
  });

  upstream.addEventListener('message', async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.toolCall?.functionCalls?.length) {
      const responses = [];
      for (const call of msg.toolCall.functionCalls) {
        sendClient({ jarvis: { tool: call.name, request: call.args?.request ?? '' } });
        let result;
        try {
          if (call.name === 'organisation_status') result = orgId ? situation(orgId).slice(0, 4000) : 'Personal workspace: no organisation selected.';
          else if (call.name === 'ask_jarvis') result = (await chat({ scope, text: String(call.args?.request ?? ''), spoken: true })).reply;
          else result = `Unknown tool ${call.name}`;
        } catch (err) {
          result = `Jarvis could not answer: ${err.message}`;
        }
        sendClient({ jarvis: { tool: call.name, result: String(result).slice(0, 2000) } });
        responses.push({ id: call.id, name: call.name, response: { result: String(result).slice(0, 12_000) } });
      }
      if (upstream.readyState === upstream.OPEN) upstream.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      return;
    }
    // Everything else (setupComplete, audio, transcriptions, turn markers) goes to the HUD as-is.
    if (client.readyState === client.OPEN) client.send(text);
  });

  upstream.addEventListener('error', () => sendClient({ jarvis: { error: 'upstream', message: 'Could not reach the Gemini Live API. Check the key and the internet connection.' } }));
  upstream.addEventListener('close', (ev) => {
    if (ev.code && ev.code !== 1000 && ev.code !== 1005) {
      sendClient({ jarvis: { error: 'closed', message: `Gemini closed the session (${ev.code}${ev.reason ? `: ${ev.reason}` : ''}).` } });
      log('warn', `Voice: Gemini closed the session (${ev.code}) ${ev.reason || ''}`, orgId);
    }
    closeAll();
  });

  client.on('message', (data) => {
    if (upstream.readyState !== upstream.OPEN) return;
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.type === 'audio' && typeof m.data === 'string') upstream.send(JSON.stringify({ realtimeInput: { audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } } }));
    else if (m.type === 'text' && m.text) upstream.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: String(m.text).slice(0, 4000) }] }], turnComplete: true } }));
    else if (m.type === 'end') closeAll('ended by the owner');
  });
  client.on('close', () => closeAll());
  client.on('error', () => closeAll());
}
