# OpenChamber background jobs for OpenCode V2

The companion panel for `opencode-monitor`, adapted from `opencode-perk`'s V1 visualization. OpenChamber's SDK is now version 2.x, but the extension manifest and iframe protocol remain **apiVersion 1**. The existing panel, theme, storage, session, and local-service interfaces still work.

## What the panel shows

- Shell calls launched with `background: true` in the selected session and every descendant linked by `parentID`, across their project directories.
- Running jobs first, with monitored jobs first within that group.
- An amber edge and **MONITOR** badge for `monitor: true`. This means monitoring was requested at launch, not that notifications are still active: the monitor plugin may reach its line limit while the process keeps running.
- Command, elapsed time, owning session, exit status, expandable details, and combined stdout/stderr.
- Expand/collapse controls and per-session collapse storage. Auto-collapse closes ordinary completed jobs, keeping monitored jobs visible.
- A **Cancel job** button in each running card's header, including collapsed cards, routed through OpenCode's native shell removal operation with session-tree and native-owner checks.
- Panel cancellation notifies the owning agent and, for a descendant's job, the session whose panel you used. The message explicitly says a human cancelled the job and not to restart it automatically. Structured cancellation metadata preserves **Cancelled by human** across panel/service reloads. Direct service calls default to an agent actor; the graphical panel explicitly identifies its action as human-initiated.

The panel works for ordinary background shells without the monitor plugin. The plugin supplies incremental conversation notifications; the panel observes native job state independently.

The OpenCode plugin also works without this extension or OpenChamber. There are no imports from the plugin into this extension or from the extension into the plugin. This directory owns its development dependencies and lockfile; the root plugin's install, checks, and tests do not build or load OpenChamber code.

## Install from this checkout

Run from the repository root:

```sh
npm --prefix openchamber-extension install
npm run check:extension
```

Then have an agent **inside the OpenChamber instance you use** run:

```sh
npm run connect:openchamber
```

The connection helper uses the active OpenChamber environment to identify and verify its OpenCode backend. It writes a private `~/.config/opencode-monitor/connection.json` containing the backend URL and authentication headers. Credentials stay outside this package and its iframe.

In **Settings → Extensions → Add**, choose the absolute path of this `openchamber-extension` directory. Allow the local service and open **Background jobs** on the right-hand rail. If an already-open app has not picked up the new rail icon, reload its UI.

**After OpenChamber restarts or changes its backend**, rerun `npm run connect:openchamber`. The service rereads the connection file on requests. This proof of concept selects one OpenChamber backend per OS user. It does not silently fall back to the standalone OpenCode service, which may be a different process with different live jobs.

Rebuild after edits with `npm run build:extension`. Reload the panel for frontend edits; disable and re-enable the extension for service edits. Bundles are generated locally and gitignored. A distributed archive must include both built `main.js` files.

## V1 versus V2

| Responsibility | Perk (V1) | Monitor + this panel (V2) |
| --- | --- | --- |
| Process execution and completion notification | Perk runtime and spool | Native OpenCode shell |
| Incremental conversation updates | `$PERK_DRIP` file | `monitor: true`, output lines |
| Job discovery | Perk launch records | Paginated assistant tool history |
| Live state and output | Perk sidecar files | V2 shell get/output APIs |
| Session scope | Current session | Current session and recursive descendants |
| Output channels | stdout, stderr, progress | Combined stdout/stderr |
| Stop | Request to Perk's process owner | Native shell remove API |
| OpenChamber integration | SDK 1.x, manifest API 1 | SDK 2.x, manifest API 1 |

The panel retains Perk's card layout, but uses keyed DOM updates so refreshing status does not recreate output views, lose text selection, or close details.

## Lifecycle limits

- OpenCode's shell list only includes running jobs. The panel instead recovers background shell IDs and monitoring flags from structured tool records, including pages before compaction, then looks up their native status. It never infers IDs from conversation prose. Shells launched outside recorded `shell` tool calls are not included.
- **Cancellation also removes native output.** Already displayed output stays in the current panel until it reloads. OpenCode 2.0.16 also emits `Shell.NotFoundError` to the conversation when a background tool's shell is removed this way, although the process has been stopped. The panel sends its explicit cancellation notice after successful removal to explain the intent. If notification fails, the panel reports that cancellation succeeded but agent notification could not be confirmed; it does not claim the stop failed or retry it.
- Native shell records can expire. The panel recovers exit codes and cancellation provenance from structured metadata in synthetic session messages, even after the live record is gone. Output then shows as no longer retained. Completion-message delivery can lag behind process exit, so its timestamp is not used to invent an elapsed duration. Missing records with no recorded exit code or cancellation notice stay visible as **Record unavailable**. Cancellation provenance becomes recoverable when the notice appears in the owning session's history.
- Perk's estimated duration, separate progress channel, and friendly launch label have no equivalents in the native shell records used here. Titles show the first command line and elapsed time is actual wall time.
- Output requests are bounded to 32 KiB per read and the UI retains the most recent 256 Ki characters. Only expanded cards fetch output. The first history scan may take longer for large session trees; later scans revisit recent messages.

## Checks

From the repository root, `npm run check:extension` typechecks the service and panel and builds their bundles. `npm --prefix openchamber-extension test` checks recursive discovery, history pagination, in-flight tool updates, monitoring flags, exit transitions, ownership checks, cancellation provenance, notification failures, and missing-record behavior. Root `npm run check` and `npm test` are independent checks for the OpenCode plugin. The live smoke test used OpenChamber 2.x with OpenCode 2.0.16: recovered a completed job, displayed a running monitored job and its output, and stopped it using the rendered panel button.

Sources: [OpenChamber SDK](https://github.com/openchamber/openchamber/tree/main/packages/sdk), [V2 migration](https://opencode.ai/v2/docs/migrate-v1), and the active server's `/openapi.json` shell/session contracts.
