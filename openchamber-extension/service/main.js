// service/main.ts
import { createServer } from "node:http";
import { readFile as readFile2, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// jobs.ts
function candidates(message) {
  const result = [];
  for (const raw of message.content ?? []) {
    const part = raw;
    if (part.type !== "tool" || part.name !== "shell") continue;
    const input = part.state?.input;
    const id = part.state?.metadata?.shellID;
    if (input?.background !== true || typeof id !== "string" || !/^sh_[\w-]+$/.test(id)) continue;
    result.push({ id, command: String(input.command ?? ""), monitored: input.monitor === true, started: part.time?.ran ?? part.time?.created ?? 0 });
  }
  return result;
}
function foregroundCalls(message) {
  const result = [];
  for (const raw of message.content ?? []) {
    const part = raw;
    if (part.type !== "tool" || part.name !== "shell" || !["running", "streaming"].includes(part.state?.status ?? "")) continue;
    const input = part.state?.input;
    if (input?.background === true || typeof input?.command !== "string") continue;
    result.push({
      command: input.command,
      started: part.time?.ran ?? part.time?.created ?? 0,
      shellID: typeof part.state?.metadata?.shellID === "string" ? part.state.metadata.shellID : void 0
    });
  }
  return result;
}
var Jobs = class {
  constructor(api) {
    this.api = api;
  }
  api;
  histories = /* @__PURE__ */ new Map();
  foreground = /* @__PURE__ */ new Map();
  activeCalls = /* @__PURE__ */ new Map();
  async tree(root) {
    const first = await this.api(`/api/session/${encodeURIComponent(root)}`);
    const sessions = [first.data];
    const seen = /* @__PURE__ */ new Set([root]);
    for (let i = 0; i < sessions.length; i++) {
      let cursor;
      do {
        const page = await this.api("/api/session", { parentID: sessions[i].id, limit: "100", ...cursor ? { cursor } : {} });
        for (const child of page.data) if (!seen.has(child.id)) {
          seen.add(child.id);
          sessions.push(child);
        }
        cursor = page.cursor?.next;
      } while (cursor);
    }
    return sessions;
  }
  async history(session) {
    let history = this.histories.get(session.id);
    if (!history) {
      history = { jobs: /* @__PURE__ */ new Map(), exits: /* @__PURE__ */ new Map() };
      this.histories.set(session.id, history);
    }
    let cursor;
    let head;
    let reached = false;
    let active = this.activeCalls.get(session.id);
    if (!active) {
      active = /* @__PURE__ */ new Map();
      this.activeCalls.set(session.id, active);
    }
    do {
      const page = await this.api(`/api/session/${session.id}/message`, {
        type: "assistant",
        limit: history.head ? "10" : "100",
        ...cursor ? { cursor } : { order: "desc" }
      });
      head ??= page.data[0]?.id;
      for (const message of page.data) {
        const calls = foregroundCalls(message);
        if (calls.length) active.set(message.id, calls);
        else active.delete(message.id);
        for (const job of candidates(message)) if (!history.jobs.has(job.id)) {
          history.jobs.set(job.id, { ...job, sessionID: session.id, sessionTitle: session.title ?? session.id, directory: session.location.directory, status: "unavailable" });
        }
        if (message.id === history.head) reached = true;
      }
      cursor = page.cursor?.next;
    } while (cursor && !reached);
    history.head = head;
    cursor = void 0;
    head = void 0;
    reached = false;
    do {
      const page = await this.api(`/api/session/${session.id}/message`, {
        type: "synthetic",
        limit: history.completionHead ? "10" : "100",
        ...cursor ? { cursor } : { order: "desc" }
      });
      head ??= page.data[0]?.id;
      for (const message of page.data) {
        const metadata = message.metadata;
        if (metadata?.source === "shell" && typeof metadata.shellID === "string" && typeof metadata.exit === "number") {
          history.exits.set(metadata.shellID, metadata.exit);
        }
        if (metadata?.source === "opencode-monitor" && metadata.event === "job.cancelled" && metadata.sessionID === session.id && (metadata.actor === "human" || metadata.actor === "agent") && typeof metadata.shellID === "string") {
          const job = history.jobs.get(metadata.shellID);
          if (job) Object.assign(job, {
            status: "killed",
            cancelledBy: metadata.actor,
            retained: false,
            completed: typeof metadata.cancelledAt === "number" ? metadata.cancelledAt : void 0
          });
        }
        if (message.id === history.completionHead) reached = true;
      }
      cursor = page.cursor?.next;
    } while (cursor && !reached);
    history.completionHead = head;
    return { history, active: [...active.values()].flat() };
  }
  async list(root) {
    const sessions = await this.tree(root);
    const jobs2 = [];
    const warnings = [];
    const runningByDirectory = /* @__PURE__ */ new Map();
    for (const session of sessions) {
      try {
        const { history, active } = await this.history(session);
        this.foreground.delete(session.id);
        for (const job of history.jobs.values()) {
          if (job.status === "running" || job.status === "unavailable") {
            try {
              const { data } = await this.api(`/api/shell/${job.id}`, { "location[directory]": job.directory });
              if (data.metadata.sessionID !== session.id) continue;
              Object.assign(job, { status: data.status, exit: data.exit, started: data.time.started, completed: data.time.completed, file: data.file, cwd: data.cwd, retained: true });
            } catch (error) {
              if (!(error instanceof ApiError && error.status === 404)) throw error;
              const exit = history.exits.get(job.id);
              job.status = exit === void 0 ? "unavailable" : "exited";
              job.exit = exit;
              job.retained = false;
            }
          }
          if (job.notificationError) warnings.push(job.notificationError);
          jobs2.push({ ...job });
        }
        if (active.length) {
          let shells = runningByDirectory.get(session.location.directory);
          if (!shells) {
            const response = await this.api("/api/shell", { "location[directory]": session.location.directory });
            shells = response.data;
            runningByDirectory.set(session.location.directory, shells);
          }
          const used = /* @__PURE__ */ new Set();
          const foreground = /* @__PURE__ */ new Map();
          for (const call of active) {
            const native = shells.find((shell) => shell.status === "running" && shell.metadata.sessionID === session.id && !history.jobs.has(shell.id) && !used.has(shell.id) && shell.command === call.command && (call.shellID ? shell.id === call.shellID : call.started > 0 && Math.abs(shell.time.started - call.started) <= 2e3));
            if (!native) continue;
            used.add(native.id);
            const job = {
              id: native.id,
              sessionID: session.id,
              sessionTitle: session.title ?? session.id,
              directory: session.location.directory,
              command: native.command,
              monitored: false,
              foreground: true,
              status: "running",
              started: native.time.started,
              file: native.file,
              cwd: native.cwd,
              retained: true
            };
            foreground.set(job.id, job);
            jobs2.push({ ...job });
          }
          this.foreground.set(session.id, foreground);
        }
      } catch (error) {
        warnings.push(`${session.title ?? session.id}: ${String(error)}`);
      }
    }
    return { jobs: jobs2.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || Number(b.monitored) - Number(a.monitored) || b.started - a.started), sessions: sessions.length, warnings, foregroundSupported: true };
  }
  async owned(root, id) {
    const sessionIDs = new Set((await this.tree(root)).map((s) => s.id));
    for (const sessionID of sessionIDs) {
      const job = this.histories.get(sessionID)?.jobs.get(id) ?? this.foreground.get(sessionID)?.get(id);
      if (job) return job;
    }
    throw new ApiError(404, "Job is not in this session tree. Refresh the panel.");
  }
  async output(root, id, cursor) {
    const job = await this.owned(root, id);
    const { data } = await this.api(`/api/shell/${id}`, { "location[directory]": job.directory });
    if (data.metadata.sessionID !== job.sessionID) throw new ApiError(404, "Job belongs to a different session.");
    const result = await this.api(`/api/shell/${id}/output`, { "location[directory]": job.directory, cursor: String(cursor), limit: "32768" });
    return result.data;
  }
  async stop(root, id, actor = "agent") {
    const job = await this.owned(root, id);
    if (job.foreground) throw new ApiError(409, "Foreground commands are controlled by their owning agent and cannot be cancelled from this panel.");
    const query = { "location[directory]": job.directory };
    const { data } = await this.api(`/api/shell/${id}`, query);
    if (data.metadata.sessionID !== job.sessionID) throw new ApiError(404, "Job belongs to a different session.");
    if (data.status !== "running") throw new ApiError(409, "Job already finished. Refresh the panel.");
    await this.api(`/api/shell/${id}`, query, "DELETE");
    job.status = "killed";
    job.completed = Date.now();
    job.retained = false;
    job.cancelledBy = actor;
    const failures = [];
    for (const sessionID of /* @__PURE__ */ new Set([job.sessionID, root])) {
      try {
        await this.api(`/api/session/${sessionID}/synthetic`, {}, "POST", {
          text: `${actor === "human" ? "A human" : "An agent"} cancelled background job ${id}${actor === "human" ? " from the Background jobs panel" : ""}.
Command: ${job.command}
Owning session: ${job.sessionID}
This cancellation was intentional, not an unexplained process failure. Do not automatically restart the job${actor === "human" ? " unless the human asks" : ""}. OpenCode may also report Shell.NotFoundError because cancellation removes the shell record.`,
          description: `Job cancelled by ${actor}`,
          metadata: { source: "opencode-monitor", event: "job.cancelled", actor, shellID: id, sessionID: job.sessionID, panelSessionID: root, cancelledAt: job.completed },
          delivery: "steer"
        });
      } catch (error) {
        failures.push(`${sessionID}: ${String(error)}`);
      }
    }
    job.notificationError = failures.length ? `Job ${id} was cancelled, but its agent notification could not be confirmed: ${failures.join("; ")}` : void 0;
    return { stopped: true, notified: failures.length === 0, warning: job.notificationError };
  }
};
var ApiError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};

// service/discover.ts
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var exec = promisify(execFile);
var registry = join(homedir(), ".config/openchamber/managed-opencode");
async function discoverBackend(directory = registry, ownerPid = process.ppid, passwordFor = backendPassword) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    throw new Error("No OpenChamber managed backend registry found.");
  }
  const instances = [];
  for (const entry of entries.filter((name) => /^\d+\.json$/.test(name))) {
    try {
      const instance = JSON.parse(await readFile(join(directory, entry), "utf8"));
      if (instance.runtime === "desktop" && instance.pid === Number(entry.slice(0, -5)) && Number.isSafeInteger(instance.ownerPid) && instance.ownerPid > 0 && Number.isSafeInteger(instance.port) && instance.port > 0 && instance.port < 65536) instances.push(instance);
    } catch {
    }
  }
  const owned = instances.filter((instance) => instance.ownerPid === ownerPid);
  const candidates2 = owned.length ? owned : instances;
  const live = [];
  for (const instance of candidates2) {
    const password = await passwordFor(instance.pid);
    if (!password) continue;
    const url = `http://127.0.0.1:${instance.port}`;
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    try {
      const response = await fetch(new URL("/api/info", url), { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json()).pid === instance.pid) live.push({ url, headers });
    } catch {
    }
  }
  if (live.length !== 1) throw new Error(live.length ? "Multiple OpenChamber backends found; run npm run connect:openchamber in the intended instance." : "No verifiable OpenChamber backend found; run npm run connect:openchamber inside OpenChamber.");
  return live[0];
}
async function backendPassword(pid) {
  if (process.platform !== "darwin") return void 0;
  try {
    const { stdout } = await exec("ps", ["eww", "-p", String(pid)], { maxBuffer: 1024 * 1024 });
    const line = stdout.split("\n").find((row) => row.includes("opencode serve"));
    return line?.match(/(?:^|\s)OPENCODE_SERVER_PASSWORD=([^\s]+)/)?.[1];
  } catch {
    return void 0;
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!port || !token) throw new Error("OpenChamber service port and token are required");
var connectionKey = "";
var connectionFile = join2(homedir2(), ".config/opencode-monitor/connection.json");
var connection;
var jobs;
var reconnecting;
var snapshots = /* @__PURE__ */ new Map();
async function reconnect() {
  reconnecting ??= (async () => {
    const next = await discoverBackend();
    await mkdir(join2(homedir2(), ".config/opencode-monitor"), { recursive: true, mode: 448 });
    const temporary = `${connectionFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 384 });
    await rename(temporary, connectionFile);
    connection = next;
    connectionKey = "";
    snapshots.clear();
  })().finally(() => {
    reconnecting = void 0;
  });
  await reconnecting;
}
async function connected() {
  let raw;
  try {
    raw = await readFile2(connectionFile, "utf8");
  } catch {
    try {
      await reconnect();
      raw = await readFile2(connectionFile, "utf8");
    } catch {
      throw new ApiError(503, "Run npm run connect:openchamber from this checkout inside OpenChamber.");
    }
  }
  if (raw !== connectionKey) {
    connection = JSON.parse(raw);
    const api = async (path, query = {}, method = "GET", body) => {
      const request = () => {
        const url = new URL(path, connection.url);
        url.search = new URLSearchParams(query).toString();
        return fetch(url, { method, headers: { ...connection.headers, ...body === void 0 ? {} : { "Content-Type": "application/json" } }, body: body === void 0 ? void 0 : JSON.stringify(body), signal: AbortSignal.timeout(1e4) });
      };
      let response;
      try {
        response = await request();
      } catch {
        if (method !== "GET") throw new ApiError(503, "OpenCode backend unavailable. Retry after reconnecting OpenChamber.");
        try {
          await reconnect();
        } catch {
          throw new ApiError(503, "OpenCode backend unavailable. Run npm run connect:openchamber inside OpenChamber.");
        }
        try {
          response = await request();
        } catch {
          throw new ApiError(503, "OpenCode backend unavailable after reconnecting OpenChamber.");
        }
      }
      if (method === "GET" && (response.status === 401 || response.status === 403)) {
        try {
          await reconnect();
        } catch {
          throw new ApiError(503, "OpenCode backend unavailable. Run npm run connect:openchamber inside OpenChamber.");
        }
        try {
          response = await request();
        } catch {
          throw new ApiError(503, "OpenCode backend unavailable after reconnecting OpenChamber.");
        }
      }
      if (!response.ok) throw new ApiError(response.status, `OpenCode ${path}: HTTP ${response.status}`);
      return response.status === 204 ? void 0 : await response.json();
    };
    jobs = new Jobs(api);
    snapshots.clear();
    connectionKey = raw;
  }
  return jobs;
}
createServer(async (request, response) => {
  const json = (status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(401, { error: "Unauthorized" });
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      json(200, { ok: true });
      return;
    }
    const root = url.searchParams.get("session") ?? "";
    if (!/^ses_[\w-]+$/.test(root)) throw new ApiError(400, "A session ID is required");
    const store = await connected();
    if (request.method === "GET" && url.pathname === "/jobs") {
      let cached = snapshots.get(root);
      if (!cached || Date.now() - cached.at > 1500) {
        const entry = { at: Infinity, promise: store.list(root) };
        snapshots.set(root, entry);
        entry.promise.then(() => {
          entry.at = Date.now();
        }, () => {
          snapshots.delete(root);
        });
        cached = entry;
      }
      json(200, await cached.promise);
      return;
    }
    const match = url.pathname.match(/^\/jobs\/(sh_[\w-]+)\/(output|stop)$/);
    if (match?.[2] === "output" && request.method === "GET") {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError(400, "Invalid output cursor");
      json(200, await store.output(root, match[1], cursor));
      return;
    }
    if (match?.[2] === "stop" && request.method === "POST") {
      const actor = url.searchParams.get("actor") ?? "agent";
      if (actor !== "human" && actor !== "agent") throw new ApiError(400, "Invalid cancellation actor");
      json(200, await store.stop(root, match[1], actor));
      snapshots.clear();
      return;
    }
    throw new ApiError(404, "Not found");
  } catch (error) {
    json(error instanceof ApiError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(port, "127.0.0.1");
