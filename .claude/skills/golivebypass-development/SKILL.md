---
name: golivebypass-development
description: Use when changing the GoLiveBypass Safe installer, Discord injection, Tor runtime, PAC routing, packaging, or recovery tests. Not for unrelated project administration.
user-invocable: false
metadata:
  updated: "2026-08-23"
---

# GoLiveBypass Safe Development

## Invariants

1. Support Windows only unless a separately audited platform implementation is added.
2. Route protected `discord.gg` hosts through the owned Tor runtime with no `DIRECT` fallback.
3. Do not add free proxies, remote bootstrap scripts, auto-update, Discord token access, account stores, stream diagnostics, or arbitrary renderer logging.
4. Refuse existing `_app.asar`, directories at `app.asar`, and ownership markers that do not match the canonical resources path.
5. Keep both the renamed original and a SHA-256-verified external backup before committing a loader.
6. Journal filesystem transitions before they happen and keep recovery idempotent.
7. Stop only processes whose `ExecutablePath` exactly matches a discovered Discord target. Restart only flavours that were running.
8. Validate every IPC sender against the manager window and keep the renderer sandboxed with context isolation.
9. Keep updater and publication configuration absent. Builds are local and `--publish never`.
10. Require an exact manifest-to-file-tree match and reject absolute paths, parent segments, drive prefixes, alternate data streams, links, junction escapes, and unlisted files.
11. Reuse a saved Tor PID only after its Windows `ExecutablePath` exactly matches the packaged `tor.exe`.
12. Keep production Electron fuses fail-closed: disable RunAsNode, Node options, and CLI inspection; require the integrity-checked `app.asar`.

## Runtime Layout

- `runtime/payload.cjs`: code loaded by Discord before its original main module.
- `runtime/proxy.pac`: protected-host routing rule. Protected results must contain one SOCKS endpoint and no fallback separator.
- `runtime/runtime-safety.cjs`: path-confinement and Windows process-identity checks shared with the injected payload.
- `vendor/tor/`: generated, ignored files from the pinned official Tor archive.
- `vendor/tor-manifest.json`: generated hashes for every packaged Tor file.
- Development reads the split `runtime/` and `vendor/` trees; packaging merges them into one verified runtime.
- `%LOCALAPPDATA%\GoLiveBypassSafe\runtime`: stable runtime copied by the manager.
- `%LOCALAPPDATA%\GoLiveBypassSafe\transactions`: append-only transaction journals.
- `%LOCALAPPDATA%\GoLiveBypassSafe\backups`: external original `app.asar` copies.

## Required Verification

Run these after changes:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run prepare:tor
npm.cmd run probe:tor
npm.cmd run compile
npm.cmd run build:win
```

For routing changes, also inspect `runtime/proxy.pac` and keep tests for canonical, regional, remote-auth, unrelated, and suffix-confusion hosts.

For Tor runtime changes, run the isolated network probe and verify the packaged fuse state. The probe must never start, stop, or modify Discord.

For installation changes, test normal install/uninstall, foreign-loader refusal, failure after moving the original, and failure after committing the loader.

## Documentation

Update this skill's `metadata.updated`, `README.md`, and relevant tests whenever an invariant, runtime path, recovery phase, build input, or security boundary changes.
