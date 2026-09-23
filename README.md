# opencode-monitor

> **V2 demo prototype.** Tested against OpenCode 2.0.15 in the isolated `demo/` location. The plugin is loaded only there, not from the repository root. It has not been packaged for npm.

A small OpenCode V2 plugin experiment: `shell({ command, background: true, monitor: true })` starts a native background shell command and feeds each complete output line into the originating session as a synthetic input. **Both flags must be explicit.** `monitor: true` without `background: true` fails before the command launches, so the model must state its intent to run a background watch. Ordinary shell calls pass through unchanged. Unlike perk's quiet-gap drips, the event delimiter is the newline.

The wrapper delegates execution to OpenCode's existing shell tool, so command permission checks, workdir, output capture, and background process management stay native. Native shell completion notifications still apply and repeat the full output, including any lines previously delivered by the monitor. Monitor input uses the native shell's combined output, including stderr. Each event is prefixed with the shell ID; synthetic inputs use `steer` delivery and are serialized in order. A watch lasts five minutes or 100 nonblank lines, whichever comes first. The process may outlive the watch. Filter noisy commands before enabling monitoring.

## Feel the UX

Run `npm install` in this checkout, then open a **new V2 session** rooted at `demo/` (for example, `opencode demo`). Its `.opencode/plugins/monitor.ts` loads this checkout only for that demo location. Ask:

> Use shell with `background: true` and `monitor: true` to run `for n in 1 2 3; do sleep 5; echo pulse-$n; done`. End your turn after starting it. Tell me what you notice when each line arrives. Do not poll.

You should see individual synthetic monitor inputs wake the agent while the command is still running. Native shell completion sends its own final input containing the full output.

## Intended package installation

To try this checkout in another **V2** project after installing dependencies, add its path to that project's configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-monitor"]
}
```

Example: `shell({ command: "tail -f app.log | grep --line-buffered ERROR", background: true, monitor: true })`.

The prototype currently reads the output-file path from the native background shell's result text, using its `shellID` as a cross-check. This couples it to V2's current response wording. If that wording changes, the shell still launches but the result reports that the monitor could not attach. Run `npm run check` and `npm test` for the local schema-wrapper and delivery checks.
