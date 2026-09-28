import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const registry = join(homedir(), ".config/openchamber/managed-opencode")

type Instance = { pid: number; ownerPid: number; port: number; runtime: string }

export async function discoverBackend(
  directory = registry,
  ownerPid = process.ppid,
  passwordFor = backendPassword,
): Promise<{ url: string; headers: Record<string, string> }> {
  let entries: string[]
  try { entries = await readdir(directory) }
  catch { throw new Error("No OpenChamber managed backend registry found.") }
  const instances: Instance[] = []
  for (const entry of entries.filter(name => /^\d+\.json$/.test(name))) {
    try {
      const instance = JSON.parse(await readFile(join(directory, entry), "utf8")) as Instance
      if (instance.runtime === "desktop" && instance.pid === Number(entry.slice(0, -5)) &&
          Number.isSafeInteger(instance.ownerPid) && instance.ownerPid > 0 &&
          Number.isSafeInteger(instance.port) && instance.port > 0 && instance.port < 65536) instances.push(instance)
    } catch { /* Ignore incomplete or obsolete registry entries. */ }
  }
  const owned = instances.filter(instance => instance.ownerPid === ownerPid)
  const candidates = owned.length ? owned : instances
  const live: { url: string; headers: Record<string, string> }[] = []
  for (const instance of candidates) {
    const password = await passwordFor(instance.pid)
    if (!password) continue
    const url = `http://127.0.0.1:${instance.port}`
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    try {
      const response = await fetch(new URL("/api/info", url), { headers, signal: AbortSignal.timeout(1500) })
      if (response.ok && (await response.json()).pid === instance.pid) live.push({ url, headers })
    } catch { /* A registry file may outlive its process. */ }
  }
  if (live.length !== 1) throw new Error(live.length ? "Multiple OpenChamber backends found; run npm run connect:openchamber in the intended instance." : "No verifiable OpenChamber backend found; run npm run connect:openchamber inside OpenChamber.")
  return live[0]
}

// macOS does not expose another process's environment through Node. Read only
// the managed backend's password, never log the process listing or credentials.
async function backendPassword(pid: number): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined
  try {
    const { stdout } = await exec("ps", ["eww", "-p", String(pid)], { maxBuffer: 1024 * 1024 })
    const line = stdout.split("\n").find(row => row.includes("opencode serve"))
    return line?.match(/(?:^|\s)OPENCODE_SERVER_PASSWORD=([^\s]+)/)?.[1]
  } catch { return undefined }
}
