import { createServer } from "node:http"
import { readFile, mkdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ApiError, Jobs, type Api, type Snapshot } from "../jobs.js"
import { discoverBackend } from "./discover.js"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN
if (!port || !token) throw new Error("OpenChamber service port and token are required")
let connectionKey = ""
const connectionFile = join(homedir(), ".config/opencode-monitor/connection.json")
let connection: { url: string; headers?: Record<string, string> }
let jobs: Jobs
let reconnecting: Promise<void> | undefined
const snapshots = new Map<string, { at: number; promise: Promise<Snapshot> }>()

async function reconnect() {
  reconnecting ??= (async () => {
    const next = await discoverBackend()
    await mkdir(join(homedir(), ".config/opencode-monitor"), { recursive: true, mode: 0o700 })
    const temporary = `${connectionFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
    await rename(temporary, connectionFile)
    connection = next
    connectionKey = ""
    snapshots.clear()
  })().finally(() => { reconnecting = undefined })
  await reconnecting
}

async function connected() {
  let raw: string
  try { raw = await readFile(connectionFile, "utf8") }
  catch {
    try { await reconnect(); raw = await readFile(connectionFile, "utf8") }
    catch { throw new ApiError(503, "Run npm run connect:openchamber from this checkout inside OpenChamber.") }
  }
  if (raw !== connectionKey) {
    connection = JSON.parse(raw) as { url: string; headers?: Record<string, string> }
    const api: Api = async <T>(path: string, query = {}, method = "GET", body?: unknown) => {
      const request = () => {
        const url = new URL(path, connection.url)
        url.search = new URLSearchParams(query).toString()
        return fetch(url, { method, headers: { ...connection.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
      }
      let response: Response
      try { response = await request() }
      catch {
        if (method !== "GET") throw new ApiError(503, "OpenCode backend unavailable. Retry after reconnecting OpenChamber.")
        try { await reconnect() }
        catch { throw new ApiError(503, "OpenCode backend unavailable. Run npm run connect:openchamber inside OpenChamber.") }
        try { response = await request() }
        catch { throw new ApiError(503, "OpenCode backend unavailable after reconnecting OpenChamber.") }
      }
      if (method === "GET" && (response.status === 401 || response.status === 403)) {
        try { await reconnect() }
        catch { throw new ApiError(503, "OpenCode backend unavailable. Run npm run connect:openchamber inside OpenChamber.") }
        try { response = await request() }
        catch { throw new ApiError(503, "OpenCode backend unavailable after reconnecting OpenChamber.") }
      }
      if (!response.ok) throw new ApiError(response.status, `OpenCode ${path}: HTTP ${response.status}`)
      return (response.status === 204 ? undefined : await response.json()) as T
    }
    jobs = new Jobs(api)
    snapshots.clear()
    connectionKey = raw
  }
  return jobs
}

createServer(async (request, response) => {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
  }
  if (request.headers.authorization !== `Bearer ${token}`) { json(401, { error: "Unauthorized" }); return }
  try {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname === "/health") { json(200, { ok: true }); return }
    const root = url.searchParams.get("session") ?? ""
    if (!/^ses_[\w-]+$/.test(root)) throw new ApiError(400, "A session ID is required")
    const store = await connected()
    if (request.method === "GET" && url.pathname === "/jobs") {
      let cached = snapshots.get(root)
      if (!cached || Date.now() - cached.at > 1500) {
        const entry = { at: Infinity, promise: store.list(root) }
        snapshots.set(root, entry)
        entry.promise.then(() => { entry.at = Date.now() }, () => { snapshots.delete(root) })
        cached = entry
      }
      json(200, await cached.promise)
      return
    }
    const match = url.pathname.match(/^\/jobs\/(sh_[\w-]+)\/(output|stop)$/)
    if (match?.[2] === "output" && request.method === "GET") {
      const cursor = Number(url.searchParams.get("cursor") ?? 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError(400, "Invalid output cursor")
      json(200, await store.output(root, match[1], cursor))
      return
    }
    if (match?.[2] === "stop" && request.method === "POST") {
      const actor = url.searchParams.get("actor") ?? "agent"
      if (actor !== "human" && actor !== "agent") throw new ApiError(400, "Invalid cancellation actor")
      json(200, await store.stop(root, match[1], actor))
      snapshots.clear()
      return
    }
    throw new ApiError(404, "Not found")
  } catch (error) { json(error instanceof ApiError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }) }
}).listen(port, "127.0.0.1")
