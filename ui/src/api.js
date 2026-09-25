import { useCallback, useEffect, useRef, useState } from 'react';

export class SignedOut extends Error {}

export async function api(method, url, body, headers = {}) {
  const raw = body instanceof Blob;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), 'X-Jarvis': '1', ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) {
    window.dispatchEvent(new Event('jarvis:signed-out'));
    throw new SignedOut('Signed out');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- live updates ----------
const listeners = new Set();
let source = null;

export function connectLive() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const fn of listeners) fn(ev);
  };
}

export function disconnectLive() {
  source?.close();
  source = null;
}

export function useLive(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (ev) => ref.current(ev);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
}

// Fetches a URL and refetches (debounced) whenever the service reports a change.
export function useData(url, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const load = useCallback(() => {
    if (!url) return;
    api('GET', url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => !(e instanceof SignedOut) && setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLive((ev) => {
    if (ev.type === 'log' && ev.level === 'info' && !/▶|✔|Task #/.test(ev.message)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  });
  return { data, error, reload: load };
}
