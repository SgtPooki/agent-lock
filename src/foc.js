/**
 * Filecoin Onchain Cloud upload + retrieval for agent-lock.
 *
 * publish() packs an artifact directory (its files + a signed agent-lock.json) into
 * a UnixFS CAR and uploads to Warm Storage via the Synapse SDK (filecoin-pin
 * core). The IPFS root CID is the integrity anchor: fetching bytes that hash to
 * the CID proves they are the exact reviewed bytes. retrieve() pulls files back
 * by CID over the public gateway, needing no wallet.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { depositUSDFC } from 'filecoin-pin/core/payments'
import { calibration, initializeSynapse, mainnet } from 'filecoin-pin/core/synapse'
import { cleanupTempCar, createCarFromPath } from 'filecoin-pin/core/unixfs'
import { checkUploadReadiness, executeUpload } from 'filecoin-pin/core/upload'
import { buildManifest, MANIFEST_NAME, normalizeKey } from './manifest.js'

const CHAINS = { calibration, mainnet }
const GATEWAY = process.env.AGENT_LOCK_GATEWAY || 'https://dweb.link'

function makeLogger(verbose) {
  const log = (level) => (...a) => {
    if (verbose) console.error(`[${level}]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))
  }
  const l = {
    info: log('info'), warn: log('warn'), error: (...a) => console.error('[error]', ...a),
    debug: log('debug'), trace: log('trace'), fatal: (...a) => console.error('[fatal]', ...a),
    level: verbose ? 'debug' : 'error',
  }
  l.child = () => l
  return l
}

/**
 * Pack an artifact directory + signed manifest, upload to FOC.
 * @param {string} dir
 * @param {{privateKey: string, network?: string, name?: string, version?: string, verbose?: boolean, onStatus?: (m:string)=>void}} opts
 */
export async function publish(dir, opts) {
  const { privateKey, network = 'calibration', verbose = false, onStatus = () => {} } = opts
  const logger = makeLogger(verbose)
  const chain = CHAINS[network]
  if (!chain) throw new Error(`unsupported network: ${network}`)

  const stat = await fs.stat(dir).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`not a directory: ${dir}`)

  onStatus('hashing + signing artifact inventory')
  const manifest = await buildManifest(dir, { privateKey, name: opts.name, version: opts.version })

  // Stage a copy of the dir with the manifest written in, so both land under one root CID.
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lock-pub-'))
  await fs.cp(dir, stageDir, { recursive: true })
  await fs.writeFile(path.join(stageDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)

  onStatus('packing into CAR (UnixFS)')
  const { carPath, rootCid } = await createCarFromPath(stageDir, { isDirectory: true, logger })
  const carBytes = await fs.readFile(carPath)

  onStatus(`connecting to Filecoin ${network}`)
  const synapse = await initializeSynapse({ privateKey: normalizeKey(privateKey), chain }, logger)

  try {
    onStatus('checking payment readiness')
    let readiness = await checkUploadReadiness({ synapse, fileSize: carBytes.length })
    const shortfall = readiness.capacity?.issues?.insufficientDeposit
    if (readiness.status !== 'ready' && shortfall && (readiness.walletUsdfcBalance ?? 0n) > 0n) {
      if (network === 'mainnet' && process.env.AGENT_LOCK_AUTO_FUND !== '1') {
        throw new Error('deposit short; set AGENT_LOCK_AUTO_FUND=1 to auto-deposit on mainnet, or deposit USDFC manually.')
      }
      const ONE = 10n ** 18n
      const cap = BigInt(Math.round(Number(process.env.AGENT_LOCK_MAX_TOPUP_USDFC || '5') * 1e6)) * 10n ** 12n
      let topUp = shortfall * 2n > ONE ? shortfall * 2n : ONE
      if (topUp > cap) topUp = cap
      if (topUp < shortfall) throw new Error(`shortfall exceeds AGENT_LOCK_MAX_TOPUP_USDFC; raise the cap or deposit manually.`)
      onStatus(`depositing ${Number(topUp) / 1e18} USDFC into Filecoin Pay`)
      await depositUSDFC(synapse, topUp)
      readiness = await checkUploadReadiness({ synapse, fileSize: carBytes.length })
    }
    if (readiness.status !== 'ready') {
      const why = readiness.validation.errorMessage ?? 'payment setup not ready'
      const help = [readiness.validation.helpMessage, ...readiness.suggestions].filter(Boolean).join('\n')
      throw new Error(`${why}${help ? `\n${help}` : ''}`)
    }

    onStatus(`uploading ${carBytes.length} bytes to Warm Storage`)
    const upload = await executeUpload(synapse, carBytes, rootCid, {
      logger,
      contextId: `agent-lock-${manifest.name}-${manifest.publishedAt}`,
      ipniValidation: { enabled: false },
      pieceMetadata: { lockName: manifest.name, lockDigest: manifest.inventoryDigest },
    })

    return {
      manifest,
      cid: rootCid.toString(),
      pieceCid: upload.pieceCid.toString(),
      network: upload.network,
      copies: upload.copies.map((c) => ({
        providerId: String(c.providerId), dataSetId: String(c.dataSetId), pieceId: String(c.pieceId),
      })),
      gatewayURL: `${GATEWAY}/ipfs/${rootCid.toString()}`,
    }
  } finally {
    await cleanupTempCar(carPath).catch(() => {})
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Fetch a single path under a CID from the public gateway. No wallet needed. */
export async function fetchUnderCid(cid, relPath) {
  const url = `${GATEWAY}/ipfs/${cid}/${relPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${relPath} failed: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Fetch and parse the agent-lock manifest for a CID. */
export async function fetchManifest(cid) {
  const bytes = await fetchUnderCid(cid, MANIFEST_NAME)
  return JSON.parse(bytes.toString('utf8'))
}
