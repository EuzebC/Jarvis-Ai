import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess } from './process.js';
import { looksLikeLimit, parseResetTime } from '../protocol.js';

// One headless Codex turn on the ChatGPT subscription. Codex has no system-prompt flag,
// so instructions are prepended. Writes are sandboxed to the workspace.
export async function runCodex({ bin, prompt, system, cwd, timeoutMs, signal }) {
  const outFile = path.join(os.tmpdir(), `jarvis-codex-${crypto.randomUUID()}.txt`);
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-o', outFile];
  if (cwd) args.push('-C', cwd);
  args.push('-');
  const input = system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;
  const proc = await runProcess(bin, args, { input, cwd, timeoutMs, signal });

  let text = '';
  try {
    text = fs.readFileSync(outFile, 'utf8');
  } catch {
    // no final message
  }
  fs.rm(outFile, { force: true }, () => {});

  const errors = [];
  for (const line of proc.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'error' || ev.type === 'turn.failed') errors.push(ev.message || ev.error?.message || JSON.stringify(ev));
    } catch {
      // partial line
    }
  }
  // Codex also reports transient errors (reconnects) on runs that succeed, so judge by exit code + answer.
  const failed = proc.code !== 0 || !text.trim();
  const errorText = failed ? [...errors, proc.stderr].filter(Boolean).join('\n').trim() : '';
  return {
    ok: !failed && !proc.timedOut && !proc.aborted,
    text,
    costUsd: 0,
    limited: failed && looksLikeLimit(errorText),
    resetAt: failed ? parseResetTime(errorText) : null,
    timedOut: proc.timedOut,
    aborted: proc.aborted,
    error: proc.spawnError ? 'Codex is not installed or not on PATH.' : errorText.slice(0, 4000),
  };
}
