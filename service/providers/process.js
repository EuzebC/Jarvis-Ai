import { spawn, execFile } from 'node:child_process';

const MAX_OUTPUT = 8 * 1024 * 1024;

// Agent CLIs must run on the subscription logins, never on API keys that bill per token,
// and must not believe they are nested inside another Claude Code session.
const STRIPPED = [/^ANTHROPIC_API_KEY$/, /^OPENAI_API_KEY$/, /^CLAUDECODE$/, /^CLAUDE_CODE_ENTRYPOINT$/, /^CLAUDE_CODE_SSE_PORT$/, /^ELECTRON_RUN_AS_NODE$/];

export function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED.some((re) => re.test(k))));
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

// Runs a CLI with the prompt on stdin. Always resolves with what happened.
export function runProcess(bin, args, { input = '', cwd, timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, env: childEnv(), windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message, timedOut, aborted, spawnError: true });
      return;
    }
    const finish = (code, spawnError = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs ?? 15 * 60_000);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (d) => stdout.length < MAX_OUTPUT && (stdout += d));
    child.stderr.on('data', (d) => stderr.length < MAX_OUTPUT && (stderr += d));
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(-1, err.code === 'ENOENT');
    });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Quick check that a CLI exists and is signed in, for the Engines panel.
export function probe(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: 15_000, env: childEnv() }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}
