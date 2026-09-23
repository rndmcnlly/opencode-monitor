import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"

const TICK_MS = 200
const MAX_LINE = 16_384
const MAX_EVENTS = 100
const WATCH_MS = 300_000

type ShellInput = { command: string; background?: boolean; monitor?: boolean; [key: string]: unknown }
type Job = { stop: () => void }

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

/** Follow the output artifact of a native background shell for one bounded watch. */
function follow(file: string, emit: (line: string) => Promise<void>, done: () => void): Job {
  let stopped = false
  let offset = 0
  let count = 0
  let busy = false
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
    clearTimeout(deadline)
    done()
  }
  const tick = async () => {
    if (busy || stopped) return
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
  const timer = setInterval(() => void tick(), TICK_MS)
  const deadline = setTimeout(() => { stop(); send("[monitor watch expired after 5 minutes; the shell process may still be running]") }, WATCH_MS)
  void tick()
  return { stop }
}

export default Plugin.define({
  id: "opencode-monitor",
  async setup(ctx) {
    const jobs = new Set<Job>()
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
            monitor: { type: "boolean", description: "Deliver each output line as a session event for up to five minutes. Requires explicit background: true. Filter noisy output in the command." },
          },
        }
        tool.description += "\nTo monitor a command, set both background: true and monitor: true. Monitoring a foreground command is rejected before launch. Each output line becomes a session event for five minutes; ordinary shell permissions still apply."
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
          }, () => jobs.delete(job))
          jobs.add(job)
          return result
        }
      })
    })
    return () => { for (const job of jobs) job.stop() }
  },
})
