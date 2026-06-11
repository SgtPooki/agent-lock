# fixity

Pin, verify, and prove agent supply-chain artifacts by CID on [Filecoin Onchain Cloud](https://filecoin.cloud). Review once, run that exact content forever.

## ELI5

Agents load skills, MCP configs, and prompts from marketplaces and repos that can change after you reviewed them. In 2026 that became a real attack: hundreds of malicious skills shipped under innocuous names, swapped in after looking safe.

fixity makes the swap impossible instead of merely detectable. You publish an artifact and get a CID, a content address that is the hash of the bytes. Anyone installs by that CID and gets exactly the bytes you reviewed, signed by you, provably still stored on Filecoin. Change one byte upstream and the CID changes, so the old CID can never resolve to the tampered version.

`fixity` is the term from digital preservation for "the property of being unchanged, and the practice of proving it." That is the whole product.

## What it does

1. **publish**: hashes every file in an artifact directory, signs the inventory with your wallet key, packs it into a UnixFS CAR, and uploads to Filecoin Warm Storage. Prints the root CID.
2. **install**: fetches by CID over the public gateway (no wallet needed), verifies the publisher signature and re-hashes every file against the signed manifest before writing it to disk.
3. **verify**: re-hashes installed files against the pinned manifest and flags drift, file by file. Exits non-zero on drift, so it drops into CI.
4. **proven**: confirms the artifact is still retrievable from Filecoin and its signed inventory verifies.

The CID is the integrity anchor (content addressing guarantees the bytes). The signed manifest adds two things the CID alone does not: a per-file inventory so `verify` pinpoints which file drifted, and a publisher signature so you know who published it.

## Quick start

```bash
npm install
npm test

# publish an artifact (needs a funded calibration wallet)
PRIVATE_KEY=0x... fixity publish ./my-skill --name my-skill --version 1.0.0

# install it anywhere, no wallet
fixity install <cid> --to ./my-skill

# verify it hasn't drifted
fixity verify ./my-skill
```

## The attack it stops

```
fixity install <cid>          # pull the reviewed bytes, signature checked
# ... upstream repo gets compromised, ships a keylogger ...
fixity install <cid>          # same CID still yields the clean reviewed bytes
fixity verify ./my-skill      # flags any locally swapped file in red, exits 1
```

Change one byte and the CID changes, so a swapped artifact simply cannot resolve from the CID you reviewed. There is no version to silently update.

## Catching drift automatically

`verify` on its own is manual. To catch a modified skill the moment it matters, wire fixity into Claude Code at two points (full block in [examples/claude-settings.json](examples/claude-settings.json), drop into `~/.claude/settings.json` or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "fixity verify --all" }] }
    ],
    "PreToolUse": [
      { "matcher": "Skill", "hooks": [{ "type": "command", "command": "fixity hook" }] }
    ]
  }
}
```

- **SessionStart** runs `fixity verify --all ~/.claude/skills` when a session begins, so a skill swapped while you were away is flagged before any work starts.
- **PreToolUse** with matcher `Skill` runs `fixity hook` right before a skill is invoked. The hook reads Claude Code's tool payload on stdin, verifies that specific skill, and on drift emits a `permissionDecision: deny` and exits 2, so the harness **blocks the tampered skill before it runs**. Skills fixity does not manage pass through untouched.

For instant detection during development (independent of any harness), `fixity watch ~/.claude/skills` re-verifies on every file change and prints drift the moment it lands.

The honest boundary: the hook gates skills fixity manages and that route through the Skill tool. It is not a sandbox; a skill that rewrites its own directory between the SessionStart sweep and invocation is still caught by the PreToolUse gate, but content fixity never pinned is outside its scope.

## CLI

```
fixity publish <dir> [--name X] [--version Y]   pack + sign + upload; prints the CID
fixity install <cid> [--to <dir>]               fetch by CID, verify, unpack
fixity verify [dir]                             re-hash installed files vs the pinned manifest
fixity verify --all [dir]                       sweep every managed artifact (default ~/.claude/skills)
fixity proven <cid>                             retrievability + signed-inventory check
fixity hook                                     Claude Code PreToolUse gate (reads hook JSON on stdin)
fixity watch [dir]                              re-verify on every file change

env: PRIVATE_KEY (publish only), FIXITY_NETWORK (calibration|mainnet),
     FIXITY_GATEWAY, FIXITY_SKILLS_DIR (default ~/.claude/skills),
     FIXITY_MAX_TOPUP_USDFC (auto-deposit cap, default 5),
     FIXITY_AUTO_FUND=1 (required for auto-deposit on mainnet)
```

## Privacy

Storage is public. Artifacts published with fixity are world-readable by CID. This tool is for distributing artifacts that are meant to be installed widely (skills, MCP configs, prompts), not for secrets. Sign with a key you are comfortable being the public publisher of record.

## Roadmap

1. **Onchain PDP proof status** in `proven`: query the deployed WarmStorage StateView for the artifact's proof epoch, so `proven` reports "PDP-proven through epoch N" rather than just live retrievability.
2. **Signed index**: a content-addressed registry mapping publisher key to artifact name to CID history, itself pinned and PDP-proven, so discovery does not depend on a mutable server.
3. **Assisted publish**: an on-ramp for publishers without FIL/USDFC (the marketplace fronts storage for a fee), and a community-funded Filecoin Pay balance that keeps public-good artifacts proven and alive.
4. **`erc8004` publisher identity**: bind the signer to a registered onchain agent identity.

## License

Dual-licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) or [MIT](https://opensource.org/licenses/MIT), at your option.
