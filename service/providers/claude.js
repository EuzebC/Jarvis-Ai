import { runProcess } from './process.js';
import { looksLikeLimit, parseResetTime } from '../protocol.js';

function parseJson(stdout) {
  const t = stdout.trim();
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(t.split('\n').filter(Boolean).pop() ?? '');
    } catch {
      return null;
    }
  }
}

// One headless Claude Code turn on the Claude subscription. dontAsk denies every tool
// that is not explicitly allowed; the working directory is the org or project workspace.
export async function runClaude({ bin, prompt, system, model, tools, cwd, timeoutMs, signal }) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'];
  if (model) args.push('--model', model);
  if (system) args.push('--append-system-prompt', system);
  if (tools?.length) args.push('--allowedTools', tools.join(','));

  const proc = await runProcess(bin, args, { input: prompt, cwd, timeoutMs, signal });
  const json = parseJson(proc.stdout);
  const text = typeof json?.result === 'string' ? json.result : '';
  const failed = proc.code !== 0 || !json || json.is_error === true;
  const errorText = failed ? [text, proc.stderr, json ? '' : proc.stdout].filter(Boolean).join('\n').trim() : '';
  return {
    ok: !failed && !proc.timedOut && !proc.aborted,
    text,
    costUsd: Number(json?.total_cost_usd) || 0,
    limited: failed && looksLikeLimit(errorText),
    resetAt: failed ? parseResetTime(errorText) : null,
    timedOut: proc.timedOut,
    aborted: proc.aborted,
    error: proc.spawnError ? 'Claude Code is not installed or not on PATH.' : errorText.slice(0, 4000),
  };
}
