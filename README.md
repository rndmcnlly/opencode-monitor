# opencode-monitor

> **V2 demo prototype.** Tested against OpenCode 2.0.15 in the isolated `demo/` location. The plugin is loaded only there, not from the repository root. It has not been packaged for npm.

A small OpenCode V2 plugin experiment: `shell({ command, background: true, monitor: true })` starts a native background shell command and feeds each complete output line into the originating session as a synthetic input. **Both flags must be explicit.** `monitor: true` without `background: true` fails before the command launches, so the model must state its intent to run a background watch. Ordinary shell calls pass through unchanged. Unlike perk's quiet-gap drips, the event delimiter is the newline.

The wrapper delegates execution to OpenCode's existing shell tool, so command permission checks, workdir, output capture, timeout, and background process management stay native. The monitor follows until that shell exits; background shells have no timeout by default. Set the existing shell `timeout` in milliseconds when the job needs a deadline, for example `timeout: 8 * 60 * 60 * 1000` for eight hours. Native shell completion notifications still apply and repeat the full output, including any lines previously delivered by the monitor. Monitor input uses the native shell's combined output, including stderr. Each event is prefixed with the shell ID; synthetic inputs use `steer` delivery and are serialized in order. A watch stops after 100 nonblank lines to prevent a firehose; filter noisy commands before enabling monitoring. Watches are in memory and do not survive a server restart or plugin reload.

## Feel the UX

Run `npm install` in this checkout, then open a **new V2 session** rooted at `demo/` (for example, `opencode demo`). Its `.opencode/plugins/monitor.ts` loads this checkout only for that demo location. Ask:

> Use shell with `background: true` and `monitor: true` to run `for n in 1 2 3; do sleep 5; echo pulse-$n; done`. End your turn after starting it. Tell me what you notice when each line arrives. Do not poll.

You should see individual synthetic monitor inputs wake the agent while the command is still running. Native shell completion sends its own final input containing the full output.

## Install from GitHub with V2's plugin manager

OpenCode V2 accepts Git repositories as plugin sources, so no npm publication is needed:

```sh
opencode plugin add github:rndmcnlly/opencode-monitor#main
```

To scope it to one V2 project instead, put the same Git source in that project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:rndmcnlly/opencode-monitor#main"]
}
```

Example: `shell({ command: "tail -f app.log | grep --line-buffered ERROR", background: true, monitor: true })`.

The prototype currently reads the output-file path from the native background shell's result text, using its `shellID` as a cross-check. This couples it to V2's current response wording. If that wording changes, the shell still launches but the result reports that the monitor could not attach. Run `npm run check` and `npm test` for the local schema-wrapper and delivery checks.
