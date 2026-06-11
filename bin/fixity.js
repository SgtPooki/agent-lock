#!/usr/bin/env node
/**
 * fixity: pin, verify, and prove agent supply-chain artifacts by CID on
 * Filecoin Onchain Cloud. Review once, run that exact content forever.
 *
 *   fixity publish <dir>     pack + sign + upload an artifact; prints its CID
 *   fixity install <cid>     fetch by CID, verify signature + hashes, unpack
 *   fixity verify [dir]      re-hash installed files against the pinned manifest
 *   fixity proven <cid>      show PDP proof status for a published artifact
 *
 * Env: PRIVATE_KEY (publish only), FIXITY_NETWORK (calibration|mainnet),
 *      FIXITY_GATEWAY, FIXITY_DIR (default ./.fixity for install metadata)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { MANIFEST_NAME, verifyAgainstDisk, verifyManifestSelf } from '../src/manifest.js'

const NETWORK = process.env.FIXITY_NETWORK || 'calibration'
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}
const die = (m) => { console.error(`${c.red('fixity:')} ${m}`); process.exit(1) }
const short = (h) => (h ? `${h.slice(0, 14)}…` : '(none)')

async function cmdPublish(args) {
  const dir = args[0]
  if (!dir) die('usage: fixity publish <dir> [--name X] [--version Y]')
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
  console.log(`\n  install with: ${c.cyan(`fixity install ${r.cid}`)}\n`)
  process.exit(0)
}

async function cmdInstall(args) {
  const cid = args[0]
  if (!cid) die('usage: fixity install <cid> [--to <dir>]')
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
  const dir = args[0] || process.cwd()
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_NAME), 'utf8'))
  } catch {
    die(`no ${MANIFEST_NAME} in ${dir}.. run fixity install first?`)
  }
  console.log(c.bold(`\n  Verifying ${manifest.name} @ ${manifest.artifactVersion}\n`))
  const self = await verifyManifestSelf(manifest)
  console.log(self.digestOk ? `  ${c.green('✓')} manifest digest intact` : `  ${c.red('✗')} manifest digest altered`)
  if (self.signatureOk !== null) console.log(self.signatureOk ? `  ${c.green('✓')} publisher signature valid (${self.signer})` : `  ${c.red('✗')} publisher signature INVALID`)

  const disk = await verifyAgainstDisk(dir, manifest)
  for (const d of disk.drift) console.log(`  ${c.red('✗')} ${d.path}: ${c.red(d.reason)}`)
  if (disk.ok && self.digestOk && self.signatureOk !== false) {
    console.log(`  ${c.green('✓')} all ${manifest.files.length} files match the pinned manifest`)
    if (manifest._cid) console.log(`  ${c.dim(`pinned at CID ${manifest._cid}`)}`)
    console.log()
  } else {
    console.log(`\n  ${c.red('✗ DRIFT: local files differ from the reviewed, pinned artifact.')}`)
    if (manifest._cid) console.log(`  ${c.dim(`reinstall the trusted bytes: fixity install ${manifest._cid}`)}`)
    console.log()
    process.exit(1)
  }
}

async function cmdProven(args) {
  const cid = args[0]
  if (!cid) die('usage: fixity proven <cid>')
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
    default:
      console.log(`fixity: pin, verify, and prove agent artifacts by CID on Filecoin

  fixity publish <dir>     pack + sign + upload an artifact; prints its CID
  fixity install <cid>     fetch by CID, verify signature + hashes, unpack
  fixity verify [dir]      re-hash installed files against the pinned manifest
  fixity proven <cid>      show proof status for a published artifact

  env: PRIVATE_KEY (publish), FIXITY_NETWORK (calibration|mainnet), FIXITY_GATEWAY`)
  }
} catch (err) {
  die(err.message)
}
