import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import type { Job, Snapshot } from "../jobs.js"

const host = connectHost()
const root = document.querySelector<HTMLElement>("#jobs")!
const summary = document.querySelector<HTMLElement>("#summary")!
const notice = document.querySelector<HTMLElement>("#notice")!
const automatic = document.querySelector<HTMLButtonElement>("#auto")!
let sessionID: string | null = null
let generation = 0
let collapsed = new Set<string>()
let autoCollapse = false
let ready = false
let busy = false
let currentJobs: Job[] = []
type Card = { element: HTMLElement; title: HTMLButtonElement; state: HTMLElement; age: HTMLElement; owner: HTMLElement; badge: HTMLElement; stop: HTMLButtonElement; body: HTMLElement; output: HTMLElement; cursor: number; text: string; complete: boolean; loading: boolean; job: Job }
const cards = new Map<string, Card>()

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.className = className
  result.textContent = text
  return result
}
function showNotice(text: string) { notice.textContent = text; notice.hidden = !text }
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
async function request<T>(path: string, query: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<T> {
  const result = await host.serviceRequest({ path, query, method })
  const body = JSON.parse(result.body)
  if (result.status >= 400) throw new Error(body.error ?? `Service answered ${result.status}`)
  return body as T
}
function persist() {
  if (!sessionID) return
  void host.storage.set(`collapsed:${sessionID}`, [...collapsed]).catch((e) => showNotice(String(e)))
}
function fold(card: Card) {
  const closed = collapsed.has(card.job.id)
  card.title.setAttribute("aria-expanded", String(!closed))
  card.body.hidden = closed
}
function makeCard(job: Job): Card {
  const article = element("article", "job")
  article.dataset.jobId = job.id
  const header = element("header", "card-header")
  const title = element("button", "task-summary", job.command.split("\n").find((line) => line.trim()) ?? job.id)
  const line = element("div", "status-line")
  const state = element("span", "state")
  const age = element("span", "elapsed")
  const badge = element("span", "monitor-badge", "MONITOR")
  badge.title = "Launched with monitor: true. Line notifications can stop at the plugin's limit; the process may still be running."
  const stop = element("button", "stop-control", "Cancel job")
  stop.title = "Cancel this running command. OpenCode also removes its retained output."
  stop.setAttribute("aria-label", `Cancel job: ${title.textContent}`)
  line.append(state, age, badge, stop)
  const owner = element("div", "owner")
  header.append(title, line, owner)
  const body = element("div")
  const output = element("pre", "output-view", "Waiting for output…")
  const details = element("details", "technical")
  const list = element("dl")
  for (const [term, value] of [["Shell", job.id], ["Session", job.sessionID], ["Directory", job.directory], ["Start", new Date(job.started).toISOString()]]) {
    list.append(element("dt", "", term), element("dd", "", value))
  }
  details.append(element("summary", "", "Details"), list)
  body.append(element("pre", "program", job.command), element("div", "output-header", "Live output · stdout + stderr"), output, details)
  article.append(header, body)
  const card: Card = { element: article, title, state, age, owner, badge, stop, body, output, cursor: 0, text: "", complete: false, loading: false, job }
  title.onclick = () => { if (collapsed.has(job.id)) collapsed.delete(job.id); else collapsed.add(job.id); fold(card); persist(); void readOutput(card) }
  stop.onclick = async () => {
    const selected = sessionID
    const version = generation
    if (!selected) return
    stop.disabled = true
    stop.textContent = "Cancelling…"
    try {
      const result = await request<{ stopped: boolean; notified: boolean; warning?: string }>(`/jobs/${job.id}/stop`, { session: selected, actor: "human" }, "POST")
      if (version !== generation) return
      card.complete = true
      card.output.textContent = `${card.text}\n[Cancelled by human. ${result.notified ? "Agent notified." : "Agent notification could not be confirmed."} OpenCode removed the output artifact.]`
      await refresh()
      if (result.warning) showNotice(result.warning)
    } catch (error) { if (version === generation) showNotice(`Could not cancel job: ${String(error)}`) }
    finally { stop.disabled = false; stop.textContent = "Cancel job" }
  }
  return card
}
function paint(jobs: Job[]) {
  let changed = false
  const retained = new Set(jobs.map((job) => job.id))
  for (const [id, card] of cards) if (!retained.has(id)) { card.element.remove(); cards.delete(id) }
  for (const job of jobs) {
    let card = cards.get(job.id)
    if (!card) { card = makeCard(job); cards.set(job.id, card) }
    if (autoCollapse && !job.monitored && card.job.status === "running" && job.status !== "running") { collapsed.add(job.id); changed = true }
    card.job = job
    const running = job.status === "running"
    const tone = running ? "running" : job.status === "exited" && job.exit === 0 ? "success" : "failure"
    card.element.className = `job ${tone}${job.monitored ? " monitored" : ""}`
    card.state.textContent = running ? "Running" : job.status === "exited" ? `Exited ${job.exit ?? "?"}` : job.status === "timeout" ? "Timed out" : job.status === "killed" ? job.cancelledBy ? `Cancelled by ${job.cancelledBy}` : "Stopped" : "Record unavailable"
    card.age.textContent = running || job.completed ? duration((job.completed ?? Date.now()) - job.started) : ""
    card.owner.textContent = `${job.sessionID === sessionID ? "This session" : "Subagent"}: ${job.sessionTitle}`
    card.owner.title = job.sessionID
    card.badge.hidden = !job.monitored
    card.stop.hidden = !running
    fold(card)
    // Keyed DOM preserves open details, output selection, scroll, and focus.
    const desiredIndex = jobs.indexOf(job)
    if (root.children[desiredIndex] !== card.element) root.insertBefore(card.element, root.children[desiredIndex] ?? null)
  }
  if (changed) persist()
}
async function readOutput(card: Card) {
  const selected = sessionID
  const version = generation
  if (!selected || collapsed.has(card.job.id) || card.loading || card.complete) return
  if (card.job.retained === false || card.job.status === "unavailable" || card.job.status === "killed") {
    card.output.textContent = card.text || "Output is no longer retained by OpenCode."
    return
  }
  card.loading = true
  try {
    const chunk = await request<{ output: string; cursor: number; size: number }>(`/jobs/${card.job.id}/output`, { session: selected, cursor: String(card.cursor) })
    if (version !== generation) return
    const tail = card.output.scrollHeight - card.output.clientHeight - card.output.scrollTop < 20
    const left = card.output.scrollLeft
    card.text = (card.text + chunk.output).slice(-256 * 1024)
    card.cursor = chunk.cursor
    card.complete = card.job.status !== "running" && chunk.cursor >= chunk.size
    card.output.textContent = card.text || (card.complete ? "(no output)" : "Waiting for output…")
    card.output.scrollLeft = left
    if (tail) card.output.scrollTop = card.output.scrollHeight
  } catch (error) { if (version === generation) card.output.textContent = `${card.text}\n[${String(error)}]` }
  finally { card.loading = false }
}
async function refresh() {
  const selected = sessionID
  const version = generation
  if (!selected || !ready || busy) return
  busy = true
  try {
    const result = await request<Snapshot>("/jobs", { session: selected })
    if (version !== generation) return
    currentJobs = result.jobs
    paint(currentJobs)
    const active = currentJobs.filter((j) => j.status === "running")
    summary.textContent = `${active.length} running · ${active.filter((j) => j.monitored).length} monitored · ${result.sessions} session${result.sessions === 1 ? "" : "s"} (including subagents)`
    if (!currentJobs.length) summary.textContent += " · No background jobs yet."
    showNotice(result.warnings.join("\n"))
    await Promise.all([...cards.values()].map(readOutput))
  } catch (error) { if (version === generation) showNotice(String(error)) }
  finally { busy = false }
}
document.querySelector<HTMLButtonElement>("#expand")!.onclick = () => { collapsed.clear(); cards.forEach(fold); persist() }
document.querySelector<HTMLButtonElement>("#collapse")!.onclick = () => { collapsed = new Set(cards.keys()); cards.forEach(fold); persist() }
automatic.onclick = () => {
  autoCollapse = !autoCollapse
  automatic.setAttribute("aria-pressed", String(autoCollapse))
  void host.storage.set("auto-collapse", autoCollapse).catch((e) => showNotice(String(e)))
}
automatic.title = "Collapse ordinary jobs when they finish. Monitored jobs stay expanded."
host.onReady((context) => applyHostReady(context, document.documentElement))
host.onSession((session) => {
  const next = session?.id ?? null
  if (next === sessionID) return
  sessionID = next
  const version = ++generation
  ready = false
  currentJobs = []
  cards.clear()
  root.replaceChildren()
  collapsed.clear()
  showNotice("")
  summary.textContent = next ? "Loading session tree…" : "Open a conversation to see its jobs."
  if (!next) return
  void Promise.all([host.storage.get(`collapsed:${next}`), host.storage.get("auto-collapse")]).then(([closed, auto]) => {
    if (version !== generation) return
    collapsed = new Set(Array.isArray(closed) ? closed.filter((s): s is string => typeof s === "string") : [])
    autoCollapse = auto === true
    automatic.setAttribute("aria-pressed", String(autoCollapse))
  }).catch((e) => { if (version === generation) showNotice(String(e)) }).finally(() => {
    if (version !== generation) return
    ready = true
    void refresh()
  })
})
window.setInterval(() => { if (!document.hidden) void refresh() }, 2000)
