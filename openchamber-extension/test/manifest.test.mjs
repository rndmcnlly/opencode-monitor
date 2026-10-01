import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { test } from "node:test"
import { parseManifestJson } from "@openchamber/sdk/schemas"

// OpenChamber reads the manifest from the repository root, so a git URL
// install works; entries are paths from there and must be built.
const root = new URL("../../", import.meta.url)

test("root package.json is a valid OpenChamber manifest", async () => {
  const parsed = parseManifestJson(await readFile(new URL("package.json", root), "utf8"))
  assert.equal(parsed.ok, true, parsed.message)
  assert.ok(parsed.version, "OpenChamber needs a package version to install and update")
  const { panel, service } = parsed.manifest.contributes
  for (const path of [panel.entry, panel.entry.replace(/[^/]+$/, "main.js"), service.entry]) {
    await access(new URL(path, root))
  }
})
