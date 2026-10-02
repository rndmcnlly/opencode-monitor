# opencode-monitor

An OpenCode V2 plugin for getting progress updates from a command that keeps running in the background, comparable to [Claude Code's Monitor tool](https://code.claude.com/docs/en/whats-new/2026-w15). Start a build, test run, deployment, or log watch, then keep talking with the agent. As the command prints new lines, the agent hears about them without polling or waiting for the process to finish.

## Install

Install it globally with OpenCode's plugin manager:

```sh
opencode plugin add github:rndmcnlly/opencode-monitor#main
```

Or add it to a project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:rndmcnlly/opencode-monitor#main"]
}
```

Then ask the agent to run a command with `background: true` and `monitor: true`, for example:

```ts
shell({ command: "tail -f app.log | grep --line-buffered ERROR", background: true, monitor: true })
```

Each line of output becomes an update in the conversation. Filter noisy commands so the updates stay useful. OpenCode still notifies the session when the command finishes.

Foreground `shell` calls lasting more than 10 seconds get a short runtime note in their tool result. The first call exceeding 30 seconds in each session also gets a tip suggesting `background: true` for similar commands and `monitor: true` for live progress updates. Subsequent calls report only their runtime. This applies whether `background` was omitted or explicitly false; background calls receive neither. Tip tracking lasts for the plugin instance's lifetime.

## Optional OpenChamber Jobs panel

The former companion panel has moved into **[openchamber-jobs](../openchamber-jobs/README.md)**, an independently useful OpenChamber extension. It shows native shell jobs, live output, status, and ownership across a conversation and its subagents, and lets humans cancel background jobs with an explicit notice to the agent.

The two packages work independently: `opencode-monitor` delivers incremental output notifications without OpenChamber; `openchamber-jobs` visualizes ordinary native jobs without the monitor plugin. Together, the panel recognizes recorded `monitor: true` inputs, adds a **MONITOR** badge, and keeps monitored jobs expanded during auto-collapse.

Install Jobs from a locally built checkout or a ready-to-run release ZIP. Its GitHub Actions workflow builds release archives without committing generated JavaScript. The new repository is currently local and unpublished; the link above points to the sibling checkout. No OpenChamber code, dependencies, or build steps remain in this plugin package.

## Historical context

This plugin carries forward the incremental updates from [opencode-perk](https://github.com/rndmcnlly/opencode-perk), which also provided background jobs for OpenCode V1. V2 has background jobs built in, so monitor focuses on updates *while* a job runs. The broader idea of an assistant responding to live events also grew out of Ivan Martinez-Arias's AI/HCI thesis, [*Integrated Player Assistance with Live Coaches*](https://escholarship.org/uc/item/2pb8x2jg), where assistants receive game context in real time rather than waiting for a player to describe it. Claude Code's Monitor tool is a related, independently developed approach.
