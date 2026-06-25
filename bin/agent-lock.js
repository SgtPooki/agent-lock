#!/usr/bin/env node
/**
 * agent-lock: pin, verify, and prove agent supply-chain artifacts by CID on
 * Filecoin Onchain Cloud. Review once, run that exact content forever.
 *
 *   agent-lock publish <dir>     pack + sign + upload an artifact; prints its CID
 *   agent-lock install <cid>     fetch by CID, verify signature + hashes, unpack
 *   agent-lock verify [dir]      re-hash installed files against the pinned manifest
 *   agent-lock proven <cid>      show PDP proof status for a published artifact
 *
 * Env: PRIVATE_KEY (publish only), AGENT_LOCK_NETWORK (calibration|mainnet),
 *      AGENT_LOCK_GATEWAY, AGENT_LOCK_DIR (default ./.agent-lock for install metadata)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import { MANIFEST_NAME, isManaged, verifyInstalled, verifyManifestSelf } from '../src/manifest.js'

const SKILLS_DIR = process.env.AGENT_LOCK_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills')

const NETWORK = process.env.AGENT_LOCK_NETWORK || 'calibration'
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}
const die = (m) => { console.error(`${c.red('agent-lock:')} ${m}`); process.exit(1) }
const short = (h) => (h ? `${h.slice(0, 14)}…` : '(none)')

async function cmdPublish(args) {
  const dir = args[0]
  if (!dir) die('usage: agent-lock publish <dir> [--name X] [--version Y]')
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey) die('PRIVATE_KEY env var is required to publish')
  const name = flag(args, '--name')
  const version = flag(args, '--version')
  const { publish } = await import('../src/foc.js')
  console.log(c.bold(`\n  Publishing ${dir} to Filecoin Onchain Cloud (${NETWORK})\n`))
  const r = await publish(dir, { privateKey, network: NETWORK, name, version, onStatus: (m) => console.log(`  ${c.dim('…')} ${m}`) })
  console.log(`\n  ${c.green('✓ published')}`)
  console.log(`  name       : ${r.manifest.name} @ ${r.manifest.artifactVersion}`)
  console.log(`  files      : ${r.manifest.files.length}`)
  console.log(`  signer     : ${r.manifest.signer}`)
  console.log(`  inventory  : ${r.manifest.inventoryDigest}`)
  console.log(`  ${c.bold('CID')}        : ${c.bold(r.cid)}`)
  console.log(`  piece      : ${r.pieceCid}`)
  console.log(`  gateway    : ${r.gatewayURL}`)
  console.log(`\n  install with: ${c.cyan(`agent-lock install ${r.cid}`)}\n`)
  process.exit(0)
}

async function cmdInstall(args) {
  const cid = args[0]
  if (!cid) die('usage: agent-lock install <cid> [--to <dir>]')
  const to = flag(args, '--to') || path.join(process.cwd(), cid)
  const { fetchManifest, fetchUnderCid } = await import('../src/foc.js')

  console.log(c.bold(`\n  Installing ${short(cid)} from Filecoin\n`))
  const manifest = await fetchManifest(cid)
  const self = await verifyManifestSelf(manifest)
  if (!self.digestOk) die('manifest inventory digest does not match its file list (corrupt or forged manifest)')
  if (self.signatureOk === false) die(`manifest signature does not match claimed signer ${self.signer}`)
  console.log(`  ${c.green('✓')} manifest digest ok`)
  console.log(self.signatureOk ? `  ${c.green('✓')} signed by ${self.signer}` : `  ${c.yellow('!')} unsigned artifact (no publisher identity)`)

  await fs.mkdir(to, { recursive: true })
  for (const f of manifest.files) {
    const bytes = await fetchUnderCid(cid, f.path)
    const { sha256 } = await import('../src/manifest.js')
    if (sha256(bytes) !== f.sha256) die(`fetched ${f.path} does not match manifest hash (gateway served wrong bytes)`)
    const dest = path.join(to, f.path)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, bytes)
  }
  // Record the pin so `verify` knows the source of truth.
  await fs.writeFile(path.join(to, MANIFEST_NAME), `${JSON.stringify({ ...manifest, _cid: cid }, null, 2)}\n`)
  console.log(`  ${c.green('✓')} ${manifest.files.length} files verified + written to ${to}`)
  console.log(`\n  every byte matches the signed manifest at CID ${short(cid)}\n`)
}

async function cmdVerify(args) {
  if (args.includes('--all')) return cmdVerifyAll(args)
  const dir = args[0] || process.cwd()
  if (!(await isManaged(dir))) die(`no ${MANIFEST_NAME} in ${dir}.. run agent-lock install first?`)
  const { manifest, self, disk, ok } = await verifyInstalled(dir)

  console.log(c.bold(`\n  Verifying ${manifest.name} @ ${manifest.artifactVersion}\n`))
  console.log(self.digestOk ? `  ${c.green('✓')} manifest digest intact` : `  ${c.red('✗')} manifest digest altered`)
  if (self.signatureOk !== null) console.log(self.signatureOk ? `  ${c.green('✓')} publisher signature valid (${self.signer})` : `  ${c.red('✗')} publisher signature INVALID`)
  for (const d of disk.drift) console.log(`  ${c.red('✗')} ${d.path}: ${c.red(d.reason)}`)

  if (ok) {
    console.log(`  ${c.green('✓')} all ${manifest.files.length} files match the pinned manifest`)
    if (manifest._cid) console.log(`  ${c.dim(`pinned at CID ${manifest._cid}`)}`)
    console.log()
  } else {
    console.log(`\n  ${c.red('✗ DRIFT: local files differ from the reviewed, pinned artifact.')}`)
    if (manifest._cid) console.log(`  ${c.dim(`reinstall the trusted bytes: agent-lock install ${manifest._cid}`)}`)
    console.log()
    process.exit(1)
  }
}

/** Sweep every agent-lock-managed artifact under a directory (default ~/.claude/skills). */
async function cmdVerifyAll(args) {
  const root = args.filter((a) => !a.startsWith('--'))[0] || SKILLS_DIR
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    die(`cannot read ${root}`)
  }
  const dirs = []
  if (await isManaged(root)) dirs.push(root)
  for (const e of entries) if (e.isDirectory() && (await isManaged(path.join(root, e.name)))) dirs.push(path.join(root, e.name))

  if (dirs.length === 0) {
    console.log(c.dim(`  no agent-lock-managed artifacts under ${root}`))
    return
  }
  console.log(c.bold(`\n  Verifying ${dirs.length} artifact(s) under ${root}\n`))
  let bad = 0
  for (const d of dirs) {
    const { manifest, ok, disk, self } = await verifyInstalled(d)
    if (ok) {
      console.log(`  ${c.green('✓')} ${manifest.name} @ ${manifest.artifactVersion}`)
    } else {
      bad++
      const why = !self.digestOk ? 'manifest altered' : self.signatureOk === false ? 'bad signature' : `${disk.drift.length} file(s) drifted`
      console.log(`  ${c.red('✗')} ${manifest.name}: ${c.red(why)}`)
      for (const dr of disk.drift) console.log(`      ${c.dim(`${dr.path}: ${dr.reason}`)}`)
    }
  }
  console.log()
  if (bad > 0) {
    console.log(`  ${c.red(`✗ ${bad} of ${dirs.length} artifact(s) drifted from their pinned bytes.`)}\n`)
    process.exit(1)
  }
}

/**
 * Claude Code PreToolUse hook. Reads the hook JSON on stdin, finds the skill
 * being invoked, verifies it, and on drift emits a deny decision + exit 2 so
 * the harness blocks the tampered skill BEFORE it runs.
 * Wire as: { "matcher": "Skill", "hooks": [{ "type": "command", "command": "agent-lock hook" }] }
 */
async function cmdHook() {
  let payload = {}
  try {
    const chunks = []
    for await (const ch of process.stdin) chunks.push(ch)
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    process.exit(0) // never break the harness on malformed input
  }
  const skill = payload.tool_input?.skill_name || payload.tool_input?.name
  if (!skill) process.exit(0)
  const dir = path.join(SKILLS_DIR, skill)
  // Only gate skills agent-lock manages; unmanaged skills pass through untouched.
  if (!(await isManaged(dir))) process.exit(0)

  const { ok, disk, self } = await verifyInstalled(dir).catch(() => ({ ok: false, disk: { drift: [] }, self: {} }))
  if (ok) process.exit(0)

  const why = !self.digestOk ? 'manifest altered' : self.signatureOk === false ? 'publisher signature invalid' : `${disk.drift.length} file(s) differ from the pinned, reviewed bytes`
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `agent-lock blocked skill "${skill}": ${why}. Reinstall the trusted bytes with \`agent-lock install <cid>\`.`,
    },
  }))
  process.exit(2)
}

/** Watch a directory and re-verify the moment any managed artifact changes. */
async function cmdWatch(args) {
  const root = args[0] || SKILLS_DIR
  console.log(c.bold(`\n  agent-lock watch: ${root}`))
  console.log(c.dim('  re-verifies on every change; Ctrl-C to stop\n'))
  const recheck = debounce(async (sub) => {
    const dir = await nearestManaged(path.join(root, sub))
    if (!dir) return
    const { manifest, ok, disk } = await verifyInstalled(dir).catch(() => ({ ok: false, disk: { drift: [] } }))
    const t = new Date().toISOString().slice(11, 19)
    if (ok) console.log(`  ${c.dim(t)} ${c.green('✓')} ${manifest?.name ?? dir} intact`)
    else {
      console.log(`  ${c.dim(t)} ${c.red('✗ DRIFT')} ${manifest?.name ?? dir}`)
      for (const d of disk.drift) console.log(`      ${c.red(`${d.path}: ${d.reason}`)}`)
    }
  }, 150)
  const { watch } = await import('node:fs')
  try {
    watch(root, { recursive: true }, (_e, file) => file && recheck(file))
  } catch (e) {
    die(`watch failed (${e.message}); recursive watch needs Node 20+ and a supported platform`)
  }
}

/** Walk up from a path to the nearest dir containing a agent-lock manifest. */
async function nearestManaged(p) {
  let cur = p
  for (let i = 0; i < 8; i++) {
    if (await isManaged(cur)) return cur
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return null
}

function debounce(fn, ms) {
  const timers = new Map()
  return (key) => {
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => fn(key), ms))
  }
}

async function cmdProven(args) {
  const cid = args[0]
  if (!cid) die('usage: agent-lock proven <cid>')
  // Read-side proof check: confirm the artifact is retrievable and its manifest
  // verifies. (Full onchain PDP-epoch lookup via StateView is the next step;
  // for now this proves live retrievability + integrity, which is the demo's point.)
  const { fetchManifest } = await import('../src/foc.js')
  console.log(c.bold(`\n  Proving ${short(cid)} on Filecoin\n`))
  let manifest
  try {
    manifest = await fetchManifest(cid)
  } catch (e) {
    die(`not retrievable: ${e.message}`)
  }
  const self = await verifyManifestSelf(manifest)
  console.log(`  ${c.green('✓')} retrievable from Filecoin`)
  console.log(self.digestOk ? `  ${c.green('✓')} inventory digest intact` : `  ${c.red('✗')} inventory digest altered`)
  console.log(self.signatureOk ? `  ${c.green('✓')} signed by ${self.signer}` : `  ${c.yellow('!')} unsigned`)
  console.log(`  ${c.dim(`name: ${manifest.name} @ ${manifest.artifactVersion}, ${manifest.files.length} files`)}`)
  console.log(`  ${c.dim('onchain PDP-epoch lookup via StateView: TODO (see README roadmap)')}\n`)
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : undefined
}

const [cmd, ...args] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'publish': await cmdPublish(args); break
    case 'install': await cmdInstall(args); break
    case 'verify': await cmdVerify(args); break
    case 'proven': await cmdProven(args); break
    case 'hook': await cmdHook(); break
    case 'watch': await cmdWatch(args); break
    default:
      console.log(`agent-lock: pin, verify, and prove agent artifacts by CID on Filecoin

  agent-lock publish <dir>       pack + sign + upload an artifact; prints its CID
  agent-lock install <cid>       fetch by CID, verify signature + hashes, unpack
  agent-lock verify [dir]        re-hash installed files against the pinned manifest
  agent-lock verify --all [dir]  sweep every managed artifact (default ~/.claude/skills)
  agent-lock proven <cid>        show proof status for a published artifact
  agent-lock hook                Claude Code PreToolUse gate (reads hook JSON on stdin)
  agent-lock watch [dir]         re-verify on every file change

  env: PRIVATE_KEY (publish), AGENT_LOCK_NETWORK (calibration|mainnet),
       AGENT_LOCK_GATEWAY, AGENT_LOCK_SKILLS_DIR (default ~/.claude/skills)`)
  }
} catch (err) {
  die(err.message)
}
