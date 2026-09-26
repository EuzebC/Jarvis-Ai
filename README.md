# Jarvis for Windows

Jarvis runs your organisations and personal projects with teams of AI agents, on the **Claude Code and Codex subscriptions** you already pay for. It works on its own: every morning it looks at the goals, decides what the organisation should do, hands out missions, verifies the results, and keeps the teams busy all day. By default only payments and purchases wait for you; everything else, including the first message to a new contact, goes out by itself.

## How Jarvis runs a company

1. **The Operator** (Jarvis) plans after 7:00, reviews after 19:00, starts a new cycle every two hours while the teams have fewer than two open missions, and wakes up whenever a mission is delivered or a reply arrives. It reads the goals, KPIs, pipeline, replies, the mission board, its memory and your Obsidian notes, then creates 2 to 5 **missions** for departments and teams and writes the day's plan (shown on Home and in Obsidian). When the goals need work nobody owns yet, it creates a department or team itself.
2. **A mission** is an outcome with a *definition of done* ("crm/leads.csv has 20 verified rows; 10 intro emails proposed"). It runs as one real Claude Code session led by the department head or team leader, who delegates to the team as subagents, does research on the web and in a headless browser, runs code, and saves deliverables in the organisation's workspace.
3. **Verification.** When the session ends, deterministic checks (files exist, row counts, no placeholders) and a verifier session judge the deliverable. A failed mission is sent back with feedback, up to three rounds. "Done" means delivered.
4. **Actions leave the company only through `propose_action`.** Settings → Autonomy sets what waits for you: *Payments only* (default), *Money, contracts and deletions*, or additionally *first contacts* (then the team leader can review them instead of you). Payments and purchases always wait for you. Questions to the owner are refused: agents decide and note their assumption.
5. **Delivery.** Approved emails and proposals are sent from Gmail (daily limit) and WhatsApp messages from your WhatsApp Business number (first contacts as your approved template, free text once they reply). Everything is logged in HubSpot with contacts, companies and deals; replies come back as new missions for the team that started the conversation. Opt-outs ("stop", "not interested") are handled automatically on both channels. Actions with no connector (a form to submit, a call) appear under Approvals as "For you to do".

## Where agents can and cannot go

Each organisation has its own folder on your PC (by default `D:\JarvisCompanies\<Name>`; choose another when creating it, or move it later from the organisation page). Jarvis has full rights inside that folder and nowhere else:

```
CLAUDE.md     the organisation's mind, structure, goals, KPIs, policy and tool guide (generated)
MEMORY.md     lasting facts, maintained by the agents
knowledge/    your documents and Obsidian notes (read-only for agents)
crm/          leads.csv, contacts
projects/     software and websites the agents build
outputs/      documents, lists, reports for you
journal/      one file per mission with progress and assumptions; the daily plan
```

Sessions have the full toolset (shell, files, web search and fetch, headless browser, subagents) but every file path and shell command is checked against the folder: anything outside is refused. Your personal claude.ai connectors and Claude Code plugins are never exposed to the agents.

## Run it

```powershell
cd D:\Jarvis
npm start
```

First run: create a password in the window. Closing the window keeps the agents working (Jarvis stays in the tray and starts with Windows). Tray → **Quit and stop all agents** stops everything. Reset the password with `npm run set-password`.

**Requirements:** Claude Code signed in (`claude`, then `/login`). Optional: Codex (`codex login`) for building software when Claude is out of quota, an Anthropic API key with a monthly cap as a last resort, HubSpot Service Key, Gmail App Password, WhatsApp Business (phone number ID, permanent token, an approved template, and a public URL such as a Cloudflare or ngrok tunnel for replies), Obsidian vault (all in Settings → Connectors, with step-by-step instructions on each card).

## Talking to Jarvis

Say **“Jarvis”** or press **Ctrl+Space** anywhere. It's one continuous conversation per organisation, so Jarvis remembers what you discussed, answers from the live state, and creates missions when you ask for work.

## How it's built

```
app/                 Electron shell: window, tray, Ctrl+Space, start with Windows
service/server.js    Background service: API, timers (Outbox, replies, Operator, Obsidian)
service/brain/
  runtime.js         One sandboxed Claude Agent SDK session: tools, subagents, live progress, limits
  workspace.js       The organisation folder, CLAUDE.md generation, sandbox rules
  tools.js           Jarvis's MCP tools for agents: propose_action, add_lead, delegate, update_kpi…
  policy.js          Who approves what
  proposals.js       Policy-aware routing of outgoing actions to auto-send / leader / owner
  missions.js        Missions, team-as-subagents, verification loop, scheduler
  operator.js        The autonomy loop that runs each organisation
  chat.js            Persistent conversation with memory
  browser.js         Headless Chromium via Playwright MCP
service/connectors/  HubSpot, Gmail, Obsidian
service/outbox.js    Sending, daily limits, replies
service/optout.js    Do-not-contact list
ui/                  The HUD (React), served by the service
test/                node --test
```

Data lives in `%LOCALAPPDATA%\Jarvis`. The service listens only on `127.0.0.1:7777`.
