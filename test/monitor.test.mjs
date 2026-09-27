import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import plugin, { lines } from "../src/index.ts"

test("slow foreground shell results teach background and monitoring at completion", async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  let duration = 0
  let nativeResult
  let failure
  const calls = []
  const tool = {
    id: "shell", name: "shell", description: "native shell",
    input: Schema.Struct({ command: Schema.String, background: Schema.optional(Schema.Boolean) }),
    execute: async (input) => {
      calls.push(input)
      now += duration
      if (failure) throw failure
      return nativeResult
    },
  }
  const cleanup = await plugin.setup({
    location: { directory: "/test" },
    event: { subscribe: () => new ReadableStream({ start(controller) { controller.close() } }) },
    tool: { transform: async (callback) => {
      callback({ get: () => tool, update: (_id, edit) => edit(tool) })
    } },
  })
  try {
    let session = 0
    for (const background of [undefined, false, true]) {
      for (duration of [0, 10_000, 10_001, 30_000, 30_001, 65_000]) {
        for (const content of ["native output", [{ type: "text", text: "native output" }]]) {
          nativeResult = { content, output: { exit: 1 }, metadata: { original: true } }
          const input = { command: "slow-command", ...(background === undefined ? {} : { background }) }
          const context = { sessionID: `ses_${session++}` }
          const result = await tool.execute(input, context)
          assert.equal(calls.at(-1), input)
          if (background === true || duration <= 10_000) {
            assert.equal(result, nativeResult)
            continue
          }
          assert.equal(result.output, nativeResult.output)
          assert.equal(result.metadata, nativeResult.metadata)
          assert.deepEqual(result.content.slice(0, -1), [{ type: "text", text: "native output" }])
          const notice = result.content.at(-1).text
          assert.match(notice, /Foreground shell took/)
          assert.ok(notice.includes(`${(duration / 1000).toFixed(1)} seconds.`))
          assert.equal(notice.includes("Tip:"), duration > 30_000)
          if (duration > 30_000) {
            assert.match(notice, /background: true/)
            assert.match(notice, /monitor: true/)
            assert.match(notice, /no polling/)
            const repeated = await tool.execute(input, context)
            assert.doesNotMatch(repeated.content.at(-1).text, /Tip:/)
          }
          assert.equal(nativeResult.content, content)
        }
      }
    }
    const context = { sessionID: "ses_threshold_sequence" }
    for (const [background, elapsed, tip] of [[true, 60_000, false], [false, 20_000, false], [false, 30_000, false], [false, 31_000, true], [false, 60_000, false]]) {
      duration = elapsed
      const result = await tool.execute({ command: "sequence", background }, context)
      assert.equal(JSON.stringify(result.content).includes("Tip:"), tip)
    }
    failure = new Error("native execution failed")
    await assert.rejects(tool.execute({ command: "fail" }, {}), (error) => error === failure)
  } finally {
    cleanup()
  }
})

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
    assert.ok(received.every((item) => item.metadata?.source === "opencode-monitor"))
    await appendFile(file, "last without newline")
    events.enqueue({ type: "shell.exited", location: { directory: dir }, data: { id: "sh_example" } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(received.at(-1).text, "[monitor sh_example] last without newline")
    assert.deepEqual(received.at(-1).metadata, { source: "opencode-monitor" })
    await tool.execute({ command: "pwd" }, { sessionID: "ses_example" })
    assert.deepEqual(calls[1], { command: "pwd" })
  } finally {
    cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
