import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverBackend } from '../service/discover.ts'

test('recovers only a verified OpenChamber backend, preferring the service owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-discovery-'))
  const servers = []
  const add = async (pid, ownerPid) => {
    const server = createServer((request, response) => {
      if (request.url !== '/api/info' || request.headers.authorization !== 'Basic ' + Buffer.from('opencode:secret').toString('base64')) {
        response.writeHead(401).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ pid }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    await writeFile(join(directory, `${pid}.json`), JSON.stringify({ pid, ownerPid, port: server.address().port, runtime: 'desktop' }))
    return server
  }
  try {
    const first = await add(101, 500)
    const second = await add(102, 600)
    const passwordFor = async () => 'secret'
    assert.equal((await discoverBackend(directory, 500, passwordFor)).url, `http://127.0.0.1:${first.address().port}`)
    await assert.rejects(discoverBackend(directory, 700, passwordFor), /Multiple OpenChamber backends/)
    await new Promise(resolve => second.close(resolve))
    assert.equal((await discoverBackend(directory, 700, passwordFor)).url, `http://127.0.0.1:${first.address().port}`)
    await assert.rejects(discoverBackend(directory, 700, async () => 'wrong'), /No verifiable OpenChamber backend/)
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))))
    await rm(directory, { recursive: true, force: true })
  }
})
