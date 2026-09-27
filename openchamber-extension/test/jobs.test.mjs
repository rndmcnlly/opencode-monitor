import { test } from "node:test"
import assert from "node:assert/strict"
import { build } from "esbuild"

const result = await build({ entryPoints: [new URL("../jobs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false })
const { Jobs, ApiError, candidates } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
const session = (id, parentID) => ({ id, parentID, title: id, location: { directory: `/projects/${id}` } })
const message = (id, shellID, monitor = false, background = true) => ({ id, content: [{ type: "tool", name: "shell", state: { input: { command: "build", background, monitor }, metadata: { shellID } }, time: { ran: 100 } }] })
const shell = (id, sessionID, status = "running") => ({ id, command: "build", status, cwd: "/work", file: `/out/${id}`, metadata: { sessionID }, time: { started: 100, ...(status !== "running" ? { completed: 200 } : {}) }, ...(status === "exited" ? { exit: 0 } : {}) })

function fixture({ failNotification = false, failRemoval = false } = {}) {
  const sessions = [session("ses_root"), session("ses_child", "ses_root"), session("ses_grandchild", "ses_child"), session("ses_other")]
  const messages = new Map([
    ["ses_root", [message("msg_new", "sh_foreground", false, false), message("msg_old", "sh_root")]],
    ["ses_child", [message("msg_child", "sh_child", true)]],
    ["ses_grandchild", [message("msg_grandchild", "sh_grandchild")]],
    ["ses_other", [message("msg_other", "sh_other", true)]],
  ])
  const shells = new Map([shell("sh_root", "ses_root", "exited"), shell("sh_child", "ses_child"), shell("sh_grandchild", "ses_grandchild"), shell("sh_other", "ses_other")].map((s) => [s.id, s]))
  const calls = []
  const completions = new Map()
  const api = async (path, query = {}, method = "GET", body) => {
    calls.push({ path, query, method, body })
    if (path === "/api/session") return { data: sessions.filter((s) => s.parentID === query.parentID) }
    if (path.endsWith("/synthetic") && method === "POST") {
      if (failNotification) throw new ApiError(503, "Notification unavailable")
      const sessionID = path.split("/")[3]
      const message = { id: `msg_notice_${calls.length}`, ...body }
      completions.set(sessionID, [message, ...(completions.get(sessionID) ?? [])])
      return { data: message }
    }
    if (/\/message$/.test(path)) {
      const source = query.type === "synthetic" ? completions : messages
      const all = source.get(path.split("/")[3]) ?? []
      // Deliberately paginate history to exercise recovery before compaction.
      const offset = Number(query.cursor ?? 0)
      return { data: all.slice(offset, offset + 1), cursor: offset + 1 < all.length ? { next: String(offset + 1) } : {} }
    }
    if (path.startsWith("/api/session/")) return { data: sessions.find((s) => s.id === path.split("/")[3]) }
    const id = path.split("/")[3]
    if (!shells.has(id)) throw new ApiError(404, "gone")
    if (method === "DELETE") {
      if (failRemoval) throw new ApiError(503, "Removal unavailable")
      shells.delete(id); return
    }
    if (path.endsWith("/output")) return { data: { output: "hello", cursor: 5, size: 5, truncated: false } }
    return { data: shells.get(id) }
  }
  return { store: new Jobs(api), restart: () => new Jobs(api), messages, shells, calls, completions }
}

test("panel recovers completed jobs and recursively includes only descendants", async () => {
  const { store } = fixture()
  const snapshot = await store.list("ses_root")
  assert.equal(snapshot.sessions, 3)
  assert.deepEqual(snapshot.jobs.map((j) => j.id), ["sh_child", "sh_grandchild", "sh_root"])
  assert.equal(snapshot.jobs[0].monitored, true)
  assert.equal(snapshot.jobs[2].exit, 0)
  assert.deepEqual(snapshot.warnings, [])
})

test("panel revisits an unfinished history head and handles exit transitions", async () => {
  const { store, messages, shells } = fixture()
  await store.list("ses_root")
  messages.set("ses_root", [message("msg_new", "sh_late", true), message("msg_old", "sh_root")])
  shells.set("sh_late", shell("sh_late", "ses_root"))
  shells.set("sh_child", shell("sh_child", "ses_child", "timeout"))
  const snapshot = await store.list("ses_root")
  assert.equal(snapshot.jobs.find((j) => j.id === "sh_late").monitored, true)
  assert.equal(snapshot.jobs.find((j) => j.id === "sh_child").status, "timeout")
})

test("stop and output are scoped to the requested tree and native owner", async () => {
  const { store, shells, calls } = fixture()
  await store.list("ses_root")
  await store.list("ses_other")
  await assert.rejects(store.stop("ses_root", "sh_other"), /not in this session tree/)
  await assert.rejects(store.output("ses_root", "sh_other", 0), /not in this session tree/)
  shells.get("sh_child").metadata.sessionID = "ses_other"
  await assert.rejects(store.output("ses_root", "sh_child", 0), /different session/)
  await assert.rejects(store.stop("ses_root", "sh_child"), /different session/)
  shells.get("sh_child").metadata.sessionID = "ses_child"
  await store.stop("ses_root", "sh_child")
  assert.equal(shells.has("sh_child"), false)
  const deletion = calls.find((c) => c.method === "DELETE")
  assert.equal(deletion.query["location[directory]"], "/projects/ses_child")
  assert.equal((await store.list("ses_root")).jobs.find((j) => j.id === "sh_child").status, "killed")
})

test("missing native records remain visible without claiming to be running", async () => {
  const { store, shells } = fixture()
  shells.delete("sh_child")
  const snapshot = await store.list("ses_root")
  assert.equal(snapshot.jobs.find((j) => j.id === "sh_child").status, "unavailable")
  assert.deepEqual(candidates({ id: "msg_text", content: [{ type: "text", text: "shell ID: sh_fake background: true" }] }), [])
})

test("durable completion metadata preserves exit status after native records expire", async () => {
  const { store, shells, completions } = fixture()
  shells.delete("sh_root")
  completions.set("ses_root", [{ id: "msg_done", metadata: { source: "shell", shellID: "sh_root", state: "completed", exit: 0 } }])
  const job = (await store.list("ses_root")).jobs.find((j) => j.id === "sh_root")
  assert.equal(job.status, "exited")
  assert.equal(job.exit, 0)
  assert.equal(job.retained, false)
  // Delivery can happen later than exit. Do not turn its timestamp into duration.
  assert.equal(job.completed, undefined)
})

test("human cancellation notifies owner and viewing parent, and survives service restart", async () => {
  const { store, restart, calls } = fixture()
  await store.list("ses_root")
  assert.equal((await store.stop("ses_root", "sh_child", "human")).notified, true)
  const notices = calls.filter((c) => c.path.endsWith("/synthetic"))
  assert.deepEqual(notices.map((c) => c.path), ["/api/session/ses_child/synthetic", "/api/session/ses_root/synthetic"])
  assert.ok(calls.indexOf(notices[0]) > calls.findIndex((c) => c.method === "DELETE"))
  for (const notice of notices) {
    assert.match(notice.body.text, /A human cancelled background job sh_child/)
    assert.match(notice.body.text, /Do not automatically restart/)
    assert.equal(notice.body.delivery, "steer")
    assert.equal(notice.body.metadata.actor, "human")
    assert.equal(notice.body.metadata.sessionID, "ses_child")
  }
  const restored = (await restart().list("ses_root")).jobs.find((j) => j.id === "sh_child")
  assert.equal(restored.status, "killed")
  assert.equal(restored.cancelledBy, "human")
  assert.equal(restored.retained, false)
})

test("same-session cancellation sends one notice and direct calls do not claim a human actor", async () => {
  const { store, calls } = fixture()
  await store.list("ses_other")
  await store.stop("ses_other", "sh_other")
  const notices = calls.filter((c) => c.path.endsWith("/synthetic"))
  assert.equal(notices.length, 1)
  assert.equal(notices[0].body.metadata.actor, "agent")
})

test("failed or already-finished cancellation does not announce a human kill", async () => {
  const { store, calls } = fixture({ failRemoval: true })
  await store.list("ses_root")
  await assert.rejects(store.stop("ses_root", "sh_child", "human"), /Removal unavailable/)
  await assert.rejects(store.stop("ses_root", "sh_root", "human"), /already finished/)
  assert.equal(calls.filter((c) => c.path.endsWith("/synthetic")).length, 0)
})

test("notification failure reports successful cancellation separately", async () => {
  const { store, shells } = fixture({ failNotification: true })
  await store.list("ses_root")
  const result = await store.stop("ses_root", "sh_child", "human")
  assert.equal(result.stopped, true)
  assert.equal(result.notified, false)
  assert.equal(shells.has("sh_child"), false)
  assert.match(result.warning, /notification could not be confirmed/)
  assert.ok((await store.list("ses_root")).warnings.includes(result.warning))
})
