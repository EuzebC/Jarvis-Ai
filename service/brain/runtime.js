// Runs one agent session with the Claude Agent SDK on the owner's subscription login.
// The session has the full Claude Code toolset (shell, files, web, subagents, MCP) but is confined
// to its workspace folder by canUseTool and a PreToolUse hook. Progress streams to the live feed.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import os from 'node:os';
import { childEnv } from '../providers/process.js';
import { looksLikeLimit, parseResetTime } from '../protocol.js';
import { insideSandbox, commandAllowed } from './workspace.js';

export const GRADE_MODEL = { strong: 'opus', worker: 'sonnet', bulk: 'haiku' };
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const MAX_TEXT = 200_000;

const pathsIn = (input) => [input.file_path, input.path, input.notebook_path].filter(Boolean);

// Claude Code's own permission rules, as a second layer under the sandbox check: file tools refuse
// paths outside the working directory in every mode, and the owner's private folders, credentials
// and the Jarvis source are denied outright. Rule paths use the /c/Users/... form on Windows.
// Permission prompts from subagents can never be answered (they run outside the host's reach), so every
// tool an agent needs is ALLOWED by rule, scoped to the workspace; the PreToolUse hook below (which does
// run for subagents) is what enforces confinement, with deny rules as the floor.
const toRule = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `//${d.toLowerCase()}`);
function protectiveSettings(root) {
  const home = toRule(os.homedir());
  const src = toRule(path.resolve(import.meta.dirname, '..', '..'));
  const ws = toRule(root);
  const allow = [`Edit(${ws}/**)`, `Read(${ws}/**)`, 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'Glob', 'Grep', 'Agent', 'TodoWrite', 'mcp__jarvis', 'mcp__playwright'];
  const privateDirs = ['.claude', '.ssh', '.codex', '.config', '.aws', '.gnupg', 'Documents', 'Downloads', 'Desktop', 'OneDrive', 'Pictures', 'Videos'];
  const deny = [
    ...privateDirs.flatMap((d) => [`Read(${home}/${d}/**)`, `Edit(${home}/${d}/**)`]),
    `Read(${src}/**)`,
    `Edit(${src}/**)`,
    'Read(**/.env)',
    'Read(**/.env.*)',
    'Edit(**/.env)',
    'Edit(**/.env.*)',
    'Bash(git push*)',
    'PowerShell(git push*)',
  ];
  return { permissions: { allow, deny, blockReadsOutsideWorkingDirectories: true } };
}

// One decision function for both the permission callback and the hook, so nothing slips through.
function sandboxDecision(root, toolName, input) {
  // Every tool that runs a command (Bash, PowerShell, or anything with a command/script field) is checked the same way.
  const command = input.command ?? input.script ?? input.cmd;
  if (toolName === 'Bash' || toolName === 'PowerShell' || typeof command === 'string') {
    const r = commandAllowed(root, command ?? '');
    return r.ok ? null : `Blocked: ${r.reason} Work only inside ${root}.`;
  }
  if (PATH_TOOLS.has(toolName)) {
    for (const p of pathsIn(input)) if (!insideSandbox(root, p)) return `Blocked: ${p} is outside your workspace (${root}).`;
  }
  return null;
}

function describeTool(name, input) {
  const short = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (name === 'Bash' || name === 'PowerShell') return `runs: ${short(input.command ?? input.script)}`;
  if (name === 'Read') return `reads ${short(path.basename(String(input.file_path ?? '')))}`;
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return `writes ${short(path.basename(String(input.file_path ?? '')))}`;
  if (name === 'WebSearch') return `searches the web: ${short(input.query)}`;
  if (name === 'WebFetch') return `reads ${short(input.url)}`;
  if (name === 'Agent' || name === 'Task') return `delegates: ${short(input.description ?? input.prompt, 80)}`;
  if (name.startsWith('mcp__playwright__')) return `browser: ${name.replace('mcp__playwright__browser_', '')} ${short(input.url ?? input.text ?? '', 60)}`;
  if (name.startsWith('mcp__jarvis__')) return `${name.replace('mcp__jarvis__', '')}: ${short(input.summary ?? input.text ?? input.company ?? input.title ?? '', 80)}`;
  return `${name}`;
}

/**
 * @param {object} o
 * @param {string} o.cwd            the workspace folder (sandbox root)
 * @param {string} o.prompt
 * @param {string} [o.append]       role instructions appended to Claude Code's system prompt
 * @param {string} [o.model]        opus | sonnet | haiku
 * @param {object} [o.agents]       AgentDefinition map: the team members this session may delegate to
 * @param {object} [o.mcpServers]   { jarvis, playwright, ... }
 * @param {string} [o.resume]       session id to continue
 * @param {(ev: object) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function runSession({
  cwd,
  prompt,
  append = '',
  model = 'sonnet',
  effort,
  maxTurns = 120,
  maxBudgetUsd = 6,
  timeoutMs = 45 * 60_000,
  agents,
  mcpServers,
  resume,
  onProgress = () => {},
  signal,
  disallowedTools = [],
}) {
  const root = path.resolve(cwd);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) onAbort();

  const denials = [];
  let text = '';
  let result = null;
  let sessionId = resume ?? null;
  let toolCalls = 0;

  const deny = (message) => {
    denials.push(message);
    return { behavior: 'deny', message };
  };

  try {
    const stream = query({
      prompt,
      options: {
        cwd: root,
        model,
        ...(model === 'opus' ? { fallbackModel: 'sonnet' } : {}), // an Opus-only limit degrades instead of stopping
        ...(effort ? { effort } : {}),
        maxTurns,
        maxBudgetUsd,
        permissionMode: 'default',
        settings: protectiveSettings(root),
        settingSources: ['project'], // loads the workspace's CLAUDE.md
        // Only Jarvis's own MCP servers: never the owner's personal claude.ai connectors or plugins,
        // which would let an agent email or edit calendars around the approval gate.
        strictMcpConfig: true,
        plugins: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        env: childEnv(),
        agents,
        mcpServers,
        disallowedTools,
        ...(resume ? { resume } : {}),
        abortController: controller,
        forwardSubagentText: true,
        canUseTool: async (toolName, input) => {
          const problem = sandboxDecision(root, toolName, input);
          return problem ? deny(problem) : { behavior: 'allow', updatedInput: input };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hook) => {
                  const problem = sandboxDecision(root, hook.tool_name, hook.tool_input ?? {});
                  if (!problem) return {};
                  denials.push(problem);
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: problem } };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const m of stream) {
      if (m.session_id) sessionId = m.session_id;
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'tool_use') {
            toolCalls++;
            onProgress({ kind: 'tool', tool: block.name, text: describeTool(block.name, block.input ?? {}), subagent: m.parent_tool_use_id ? m.subagent_type ?? 'subagent' : null });
          } else if (block.type === 'text' && block.text?.trim() && !m.parent_tool_use_id) {
            onProgress({ kind: 'text', text: block.text.trim().slice(0, 400) });
          }
        }
      } else if (m.type === 'result') {
        result = m;
        text = typeof m.result === 'string' ? m.result.slice(0, MAX_TEXT) : '';
      }
    }
  } catch (err) {
    const cancelled = signal?.aborted;
    const timedOut = controller.signal.aborted && !cancelled;
    return { ok: false, text, sessionId, costUsd: 0, turns: 0, toolCalls, denials, limited: looksLikeLimit(err.message), resetAt: parseResetTime(err.message), aborted: cancelled, timedOut, error: cancelled ? 'Cancelled' : timedOut ? 'Timed out' : err.message.slice(0, 2000) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const ok = Boolean(result && !result.is_error && result.subtype === 'success');
  const errorText = ok ? '' : `${result?.subtype ?? 'no result'}${text ? `: ${text.slice(0, 1500)}` : ''}`;
  const limited = !ok && (result?.api_error_status === 429 || looksLikeLimit(errorText));
  return {
    ok,
    text,
    sessionId,
    costUsd: Number(result?.total_cost_usd) || 0,
    usage: result?.usage ?? null,
    turns: result?.num_turns ?? 0,
    toolCalls,
    denials,
    // Denials decided by Claude Code itself (not by the sandbox), e.g. prompts that never reached a decision.
    permissionDenials: (result?.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input ?? {}).slice(0, 120) })),
    subtype: result?.subtype ?? null,
    limited,
    resetAt: limited ? parseResetTime(errorText) : null,
    aborted: false,
    timedOut: false,
    error: errorText,
  };
}
