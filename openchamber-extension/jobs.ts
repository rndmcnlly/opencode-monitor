export type Session = { id: string; parentID?: string; title?: string; location: { directory: string } }
export type Shell = {
  id: string; command: string; cwd: string; file: string; pid?: number
  status: "running" | "exited" | "timeout" | "killed"
  exit?: number; metadata: Record<string, unknown>
  time: { started: number; completed?: number }
}
export type Job = {
  id: string; sessionID: string; sessionTitle: string; directory: string
  command: string; monitored: boolean; started: number; completed?: number
  status: Shell["status"] | "unavailable"; exit?: number; file?: string; cwd?: string
  retained?: boolean
  cancelledBy?: "human" | "agent"
  notificationError?: string
}
export type Snapshot = { jobs: Job[]; sessions: number; warnings: string[] }
export type Page<T> = { data: T[]; cursor?: { next?: string } }
export type Api = <T>(path: string, query?: Record<string, string>, method?: string, body?: unknown) => Promise<T>

type Message = { id: string; content?: unknown[]; metadata?: Record<string, unknown> }
type Candidate = { id: string; command: string; monitored: boolean; started: number }

/** Read structured tool records, never shell IDs mentioned in prose/output. */
export function candidates(message: Message): Candidate[] {
  const result: Candidate[] = []
  for (const raw of message.content ?? []) {
    const part = raw as { type?: string; name?: string; state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }; time?: { ran?: number; created?: number } }
    if (part.type !== "tool" || part.name !== "shell") continue
    const input = part.state?.input
    const id = part.state?.metadata?.shellID
    if (input?.background !== true || typeof id !== "string" || !/^sh_[\w-]+$/.test(id)) continue
    result.push({ id, command: String(input.command ?? ""), monitored: input.monitor === true, started: part.time?.ran ?? part.time?.created ?? 0 })
  }
  return result
}

/** A per-service read model. Native OpenCode remains the process owner. */
export class Jobs {
  private histories = new Map<string, { head?: string; completionHead?: string; jobs: Map<string, Job>; exits: Map<string, number> }>()
  constructor(private api: Api) {}

  private async tree(root: string): Promise<Session[]> {
    const first = await this.api<{ data: Session }>(`/api/session/${encodeURIComponent(root)}`)
    const sessions = [first.data]
    const seen = new Set([root])
    for (let i = 0; i < sessions.length; i++) {
      let cursor: string | undefined
      do {
        const page = await this.api<Page<Session>>("/api/session", { parentID: sessions[i].id, limit: "100", ...(cursor ? { cursor } : {}) })
        for (const child of page.data) if (!seen.has(child.id)) { seen.add(child.id); sessions.push(child) }
        cursor = page.cursor?.next
      } while (cursor)
    }
    return sessions
  }

  private async history(session: Session) {
    let history = this.histories.get(session.id)
    if (!history) {
      history = { jobs: new Map(), exits: new Map() }
      this.histories.set(session.id, history)
    }
    let cursor: string | undefined
    let head: string | undefined
    let reached = false
    do {
      const page: Page<Message> = await this.api<Page<Message>>(`/api/session/${session.id}/message`, {
        type: "assistant", limit: history.head ? "10" : "100", ...(cursor ? { cursor } : { order: "desc" }),
      })
      head ??= page.data[0]?.id
      for (const message of page.data) {
        for (const job of candidates(message)) if (!history.jobs.has(job.id)) {
          history.jobs.set(job.id, { ...job, sessionID: session.id, sessionTitle: session.title ?? session.id, directory: session.location.directory, status: "unavailable" })
        }
        // Revisit the prior head: its tool call may have completed since then.
        if (message.id === history.head) reached = true
      }
      cursor = page.cursor?.next
    } while (cursor && !reached)
    history.head = head
    cursor = undefined
    head = undefined
    reached = false
    do {
      const page: Page<Message> = await this.api<Page<Message>>(`/api/session/${session.id}/message`, {
        type: "synthetic", limit: history.completionHead ? "10" : "100", ...(cursor ? { cursor } : { order: "desc" }),
      })
      head ??= page.data[0]?.id
      for (const message of page.data) {
        const metadata = message.metadata
        if (metadata?.source === "shell" && typeof metadata.shellID === "string" && typeof metadata.exit === "number") {
          history.exits.set(metadata.shellID, metadata.exit)
        }
        if (metadata?.source === "opencode-monitor" && metadata.event === "job.cancelled" && metadata.sessionID === session.id &&
          (metadata.actor === "human" || metadata.actor === "agent") && typeof metadata.shellID === "string") {
          const job = history.jobs.get(metadata.shellID)
          if (job) Object.assign(job, { status: "killed", cancelledBy: metadata.actor, retained: false,
            completed: typeof metadata.cancelledAt === "number" ? metadata.cancelledAt : undefined })
        }
        if (message.id === history.completionHead) reached = true
      }
      cursor = page.cursor?.next
    } while (cursor && !reached)
    history.completionHead = head
    return history
  }

  async list(root: string): Promise<Snapshot> {
    const sessions = await this.tree(root)
    const jobs: Job[] = []
    const warnings: string[] = []
    for (const session of sessions) {
      try {
        const history = await this.history(session)
        for (const job of history.jobs.values()) {
          if (job.status === "running" || job.status === "unavailable") {
            try {
              const { data } = await this.api<{ data: Shell }>(`/api/shell/${job.id}`, { "location[directory]": job.directory })
              if (data.metadata.sessionID !== session.id) continue
              Object.assign(job, { status: data.status, exit: data.exit, started: data.time.started, completed: data.time.completed, file: data.file, cwd: data.cwd, retained: true })
            } catch (error) {
              if (!(error instanceof ApiError && error.status === 404)) throw error
              const exit = history.exits.get(job.id)
              job.status = exit === undefined ? "unavailable" : "exited"
              job.exit = exit
              job.retained = false
            }
          }
          if (job.notificationError) warnings.push(job.notificationError)
          jobs.push({ ...job })
        }
      } catch (error) { warnings.push(`${session.title ?? session.id}: ${String(error)}`) }
    }
    return { jobs: jobs.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || Number(b.monitored) - Number(a.monitored) || b.started - a.started), sessions: sessions.length, warnings }
  }

  private async owned(root: string, id: string) {
    const sessionIDs = new Set((await this.tree(root)).map((s) => s.id))
    for (const sessionID of sessionIDs) {
      const job = this.histories.get(sessionID)?.jobs.get(id)
      if (job) return job
    }
    throw new ApiError(404, "Job is not in this session tree. Refresh the panel.")
  }

  async output(root: string, id: string, cursor: number) {
    const job = await this.owned(root, id)
    const { data } = await this.api<{ data: Shell }>(`/api/shell/${id}`, { "location[directory]": job.directory })
    if (data.metadata.sessionID !== job.sessionID) throw new ApiError(404, "Job belongs to a different session.")
    const result = await this.api<{ data: { output: string; cursor: number; size: number; truncated: boolean } }>(`/api/shell/${id}/output`, { "location[directory]": job.directory, cursor: String(cursor), limit: "32768" })
    return result.data
  }

  async stop(root: string, id: string, actor: "human" | "agent" = "agent") {
    const job = await this.owned(root, id)
    const query = { "location[directory]": job.directory }
    const { data } = await this.api<{ data: Shell }>(`/api/shell/${id}`, query)
    if (data.metadata.sessionID !== job.sessionID) throw new ApiError(404, "Job belongs to a different session.")
    if (data.status !== "running") throw new ApiError(409, "Job already finished. Refresh the panel.")
    await this.api(`/api/shell/${id}`, query, "DELETE")
    job.status = "killed"
    job.completed = Date.now()
    job.retained = false
    job.cancelledBy = actor
    // Notify both the process owner and the session whose panel initiated it.
    // Native removal can emit Shell.NotFoundError; this records the intent.
    const failures: string[] = []
    for (const sessionID of new Set([job.sessionID, root])) {
      try {
        await this.api(`/api/session/${sessionID}/synthetic`, {}, "POST", {
          text: `${actor === "human" ? "A human" : "An agent"} cancelled background job ${id}${actor === "human" ? " from the Background jobs panel" : ""}.\nCommand: ${job.command}\nOwning session: ${job.sessionID}\nThis cancellation was intentional, not an unexplained process failure. Do not automatically restart the job${actor === "human" ? " unless the human asks" : ""}. OpenCode may also report Shell.NotFoundError because cancellation removes the shell record.`,
          description: `Job cancelled by ${actor}`,
          metadata: { source: "opencode-monitor", event: "job.cancelled", actor, shellID: id, sessionID: job.sessionID, panelSessionID: root, cancelledAt: job.completed },
          delivery: "steer",
        })
      } catch (error) { failures.push(`${sessionID}: ${String(error)}`) }
    }
    // Cancellation has already succeeded. Never present notification failure
    // as a failed stop, inviting a second attempt on a removed shell.
    job.notificationError = failures.length ? `Job ${id} was cancelled, but its agent notification could not be confirmed: ${failures.join("; ")}` : undefined
    return { stopped: true, notified: failures.length === 0, warning: job.notificationError }
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
