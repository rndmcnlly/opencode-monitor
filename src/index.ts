import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"

const TICK_MS = 200
const MAX_LINE = 16_384
const MAX_EVENTS = 100

type ShellInput = { command: string; background?: boolean; monitor?: boolean; [key: string]: unknown }
type Job = { stop: () => void; finish: () => Promise<void> }

/** A newline is the only event delimiter. A partial final line is delivered at EOF. */
export function lines(onLine: (line: string) => void) {
  let pending = ""
  let overflow = false
  return {
    push(chunk: string) {
      pending += chunk
      let end: number
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, "")
        pending = pending.slice(end + 1)
        onLine(overflow ? `[line exceeded ${MAX_LINE} characters]` : line.slice(0, MAX_LINE))
        overflow = false
      }
      if (pending.length > MAX_LINE) {
        pending = pending.slice(-1)
        overflow = true
      }
    },
    finish() {
      if (pending || overflow) onLine(overflow ? `[line exceeded ${MAX_LINE} characters]` : pending)
      pending = ""
    },
  }
}

function artifact(value: unknown): { file: string; id: string } | undefined {
  if (!value || typeof value !== "object") return
  const result = value as Record<string, unknown>
  const metadata = result.metadata && typeof result.metadata === "object"
    ? result.metadata as Record<string, unknown> : {}
  const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : {}
  const id = metadata.shellID ?? output.shellID ?? metadata.id
  if (typeof id !== "string" || !id.startsWith("sh_")) return
  const text = typeof output.output === "string" ? output.output : ""
  const file = metadata.file ?? metadata.outputPath ?? text.match(/^Output is streaming to: (.+)$/m)?.[1]
  if (typeof file === "string" && file.endsWith(`/${id}.out`)) return { file, id }
}

/** Follow the output artifact until the native shell exits or the plugin unloads. */
function follow(file: string, emit: (line: string) => Promise<void>, done: () => void): Job {
  let stopped = false
  let offset = 0
  let count = 0
  let busy = false
  let active: Promise<void> | undefined
  let delivery = Promise.resolve()
  const decoder = new TextDecoder()
  const send = (line: string) => {
    delivery = delivery.then(() => emit(line)).catch((error) => console.error("monitor delivery failed", error))
  }
  const framing = lines((line) => {
    if (!line.trim() || stopped) return
    if (++count > MAX_EVENTS) {
      stop()
      send(`[monitor stopped after ${MAX_EVENTS} lines; filter output at the source]`)
      return
    }
    send(line)
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    done()
  }
  const read = async () => {
    if (stopped) return
    busy = true
    try {
      const size = (await stat(file)).size
      if (size < offset) { offset = 0; framing.finish() }
      if (size > offset) {
        const stream = createReadStream(file, { start: offset, end: size - 1 })
        for await (const chunk of stream) framing.push(decoder.decode(chunk as Buffer, { stream: true }))
        offset = size
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        send(`[monitor read error: ${String(error)}]`)
        stop()
      }
    } finally { busy = false }
  }
  const tick = () => {
    if (busy || stopped) return active ?? Promise.resolve()
    active = read().finally(() => { active = undefined })
    return active
  }
  const timer = setInterval(() => void tick(), TICK_MS)
  void tick()
  return {
    stop,
    async finish() {
      if (stopped) return
      await tick()
      if (stopped) return
      framing.push(decoder.decode())
      framing.finish()
      stop()
      await delivery
    },
  }
}

export default Plugin.define({
  id: "opencode-monitor",
  async setup(ctx) {
    const jobs = new Map<string, Job>()
    const exited = new Set<string>()
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.location?.directory !== ctx.location.directory) continue
          if (event.type !== "shell.exited" && event.type !== "shell.deleted") continue
          const id = event.data.id
          const job = jobs.get(id)
          if (job) await job.finish()
          else {
            exited.add(id)
            if (exited.size > 1_000) exited.delete(exited.values().next().value!)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("monitor event stream failed", error)
      }
    })()
    await ctx.tool.transform((editor) => {
      const shell = editor.get("shell")
      if (!shell) return
      const input = shell.input
      if (typeof input !== "function" || !("fields" in input) || !("mapFields" in input)) {
        console.warn("opencode-monitor: unsupported shell input schema; leaving shell unchanged")
        return
      }
      const base = Schema.toJsonSchemaDocument(input as Schema.Codec<any, any>).schema
      if (base.type !== "object" || !base.properties) {
        console.warn("opencode-monitor: shell input is not an object schema; leaving shell unchanged")
        return
      }
      const execute = shell.execute
      editor.update("shell", (tool) => {
        tool.input = {
          ...base,
          properties: {
            ...(base.properties as Record<string, unknown>),
            monitor: { type: "boolean", description: "Deliver each output line as a session event while the background shell runs. Requires explicit background: true. Use shell's existing timeout to limit the job." },
          },
        }
        tool.description += "\nTo monitor a command, set both background: true and monitor: true. Monitoring a foreground command is rejected before launch. Lines arrive while the native shell runs; its existing timeout controls the duration. Background shells have no timeout by default. Ordinary shell permissions still apply."
        tool.execute = async (raw, context) => {
          const input = raw as ShellInput
          if (input.monitor !== true) return execute(raw, context)
          if (input.background !== true) throw new Error("monitor: true requires explicit background: true; command was not launched")
          const { monitor: _, ...shellInput } = input
          const result = await execute(shellInput, context)
          const source = artifact(result)
          if (!source) return {
            ...result,
            content: [...(Array.isArray(result.content) ? result.content : [{ type: "text" as const, text: String(result.content ?? "") }]),
              { type: "text" as const, text: "Monitor could not attach: native shell did not return a recognizable output path and shell ID." }],
          }
          const sessionID = context.sessionID
          const job = follow(source.file, async (line) => {
            await ctx.session.synthetic({ sessionID, text: `[monitor ${source.id}] ${line}`, description: "Monitor output", delivery: "steer" })
          }, () => jobs.delete(source.id))
          jobs.set(source.id, job)
          if (exited.delete(source.id)) void job.finish()
          return result
        }
      })
    })
    return () => {
      controller.abort()
      for (const job of jobs.values()) job.stop()
      jobs.clear()
    }
  },
})
