import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import plugin, { lines } from "../src/index.ts"

test("line framing survives split UTF-8 characters and consecutive writes", () => {
  const seen = []
  const frame = lines((line) => seen.push(line))
  const decoder = new TextDecoder()
  const bytes = Buffer.from("one\ntwo ✨\npartial")
  const split = bytes.indexOf(0xe2) + 1
  frame.push(decoder.decode(bytes.subarray(0, split), { stream: true }))
  frame.push(decoder.decode(bytes.subarray(split), { stream: true }))
  frame.finish()
  assert.deepEqual(seen, ["one", "two ✨", "partial"])
})

test("monitor wraps native shell and admits each line to the firing session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "monitor-test-"))
  const file = join(dir, "sh_example.out")
  await writeFile(file, "")
  const received = []
  const calls = []
  let events
  const stream = new ReadableStream({ start(controller) { events = controller } })
  let tool = {
    id: "shell", name: "shell", description: "native shell",
    input: Schema.Struct({ command: Schema.String, background: Schema.optional(Schema.Boolean) }),
    execute: async (input) => {
      calls.push(input)
      return { output: { output: `Command moved to the background (shell ID: sh_example).\nOutput is streaming to: ${file}`, shellID: "sh_example" }, content: "started", metadata: { shellID: "sh_example" } }
    },
  }
  const cleanup = await plugin.setup({
    location: { directory: dir },
    event: { subscribe: ({ signal }) => {
      signal.addEventListener("abort", () => events.close(), { once: true })
      return stream
    } },
    tool: { transform: async (callback) => {
      callback({ get: () => tool, update: (_id, edit) => edit(tool) })
    } },
    session: { synthetic: async (input) => { received.push(input) } },
  })
  try {
    await assert.rejects(
      tool.execute({ command: "printf 'hello\\n'", monitor: true }, { sessionID: "ses_example" }),
      /requires explicit background: true; command was not launched/,
    )
    await assert.rejects(
      tool.execute({ command: "printf 'hello\\n'", background: false, monitor: true }, { sessionID: "ses_example" }),
      /requires explicit background: true; command was not launched/,
    )
    assert.deepEqual(calls, [])
    const timeout = 8 * 60 * 60 * 1000
    await tool.execute({ command: "printf 'hello\\n'", background: true, monitor: true, timeout }, { sessionID: "ses_example" })
    await appendFile(file, "first\nsecond\n")
    await new Promise((resolve) => setTimeout(resolve, 450))
    assert.deepEqual(calls, [{ command: "printf 'hello\\n'", background: true, timeout }])
    assert.deepEqual(received.map((item) => item.text), ["[monitor sh_example] first", "[monitor sh_example] second"])
    assert.ok(received.every((item) => item.sessionID === "ses_example" && item.delivery === "steer"))
    await appendFile(file, "last without newline")
    events.enqueue({ type: "shell.exited", location: { directory: dir }, data: { id: "sh_example" } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(received.at(-1).text, "[monitor sh_example] last without newline")
    await tool.execute({ command: "pwd" }, { sessionID: "ses_example" })
    assert.deepEqual(calls[1], { command: "pwd" })
  } finally {
    cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
