# Jarvis for Windows

Jarvis runs your organisations and personal projects with teams of AI agents. It works on the **Claude Code and Codex subscriptions** you already pay for, and uses a capped API key only as a backup.

- **Personal:** Projects → Tasks.
- **Organisations:** Departments → Teams → Agents, plus Projects → Tasks.
  - Every department has a **head** and every team has a **team leader**.
  - Leaders turn tasks into assignments for their agents, and steps can wait on each other ("find leads" → "check sites" → "write email").
  - **Goals** at quarter, month and week level for the organisation, departments and teams.
  - **KPIs** for departments, teams and individual agents. Agents update them as they work.
- **Every organisation and project has its own mind:** a profile, memories (from you and learned by agents) and knowledge files. Nothing is shared between workspaces.
- **Jarvis proposes, you edit.** Describe a company and Jarvis designs the whole structure. You review it before anything is created.
- **Approvals:**
  - Anything leaving the company (emails, proposals, posts, calls, contracts) waits for you at first.
  - Each team has a "team leader can approve" switch, off until you trust the team.
  - **Payments always need you.**
- **Voice:**
  - Say **"Jarvis"** (the wake word is detected offline, on this PC) or press **Ctrl+Space** anywhere.
  - Jarvis answers out loud.
- **Iron Man HUD:**
  - 5 colour themes and 4 core animations.
  - The interface retints to each department's colour as you go deeper.

## Run it

```powershell
cd D:\Jarvis
npm start
```

The first time, Jarvis asks you to create a password. After that:

- Closing the window keeps the agents working. Jarvis stays in the tray.
- **Jarvis starts with Windows** (turn this off in Settings → This computer).
- Tray menu → **Quit and stop all agents** stops everything.

To reset the password: `npm run set-password`. This signs out every device.

## Requirements

- Claude Code and/or Codex installed and signed in (`claude`, then `/login`; `codex login`). Settings shows the sign-in status.
- Optional: an Anthropic API key and a monthly cap in Settings, used only when both subscriptions are out of quota.

## How it's built

```
app/        Electron shell: window, tray, Ctrl+Space, start with Windows
service/    Background service (Node): database, agent engine, API, voice model
  engine.js     Quota-aware scheduler, delegation chains, approvals, KPI/goal updates
  agents.js     Hierarchy, routing (Opus for leaders, Sonnet for workers, Haiku for bulk), prompts
  structure.js  "Jarvis proposes" organisation design
  ask.js        Talking to Jarvis (typed or spoken)
  mind.js       Memories, knowledge files, workspaces, results
  providers/    Claude Code, Codex, Anthropic API (backup)
ui/         React app (the HUD), served by the service
test/       node --test
```

Data lives in `%LOCALAPPDATA%\Jarvis`, so reinstalling never loses your organisations. The service listens only on `127.0.0.1:7777`.
