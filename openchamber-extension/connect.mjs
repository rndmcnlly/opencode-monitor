import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Run inside an OpenChamber terminal/tool so we select its backend, not a
// different OpenCode service sharing the same database on this machine.
const host = process.env.OPENCHAMBER_AGENT_TOOL_URL
if (!host) throw new Error("Run this command inside OpenChamber (OPENCHAMBER_AGENT_TOOL_URL is required).")
const response = await fetch(new URL("/api/info", host), { signal: AbortSignal.timeout(5000) })
if (!response.ok) throw new Error(`OpenChamber info: HTTP ${response.status}`)
const info = await response.json()
if (!info.version?.startsWith("2.") || !info.urls?.[0]) throw new Error("OpenChamber is not connected to an OpenCode V2 backend.")
const url = info.urls[0]
const headers = process.env.OPENCODE_SERVER_PASSWORD
  ? { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` }
  : {}
const check = await fetch(new URL("/api/info", url), { headers, signal: AbortSignal.timeout(5000) })
if (!check.ok || (await check.json()).pid !== info.pid) throw new Error("Could not verify the active OpenCode backend.")
const dir = join(homedir(), ".config", "opencode-monitor")
await mkdir(dir, { recursive: true, mode: 0o700 })
await writeFile(join(dir, "connection.json"), JSON.stringify({ url, headers }), { mode: 0o600 })
console.log(`Background jobs connected to OpenChamber's OpenCode ${info.version} at ${url}`)
