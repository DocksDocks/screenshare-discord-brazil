---
name: golivebypass-development
description: Use when changing the GoLiveBypass Safe installer, Discord injection, Tor runtime, PAC routing, packaging, or recovery tests. Not for unrelated project administration.
user-invocable: false
metadata:
  updated: "2026-08-25"
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
13. Keep the renamed Discord archive's filename ending in `.asar` so Electron can mount it. Preserve migration and restore support for v0.1.0's `app.asar.golive-original`.
14. A normal NSIS uninstall must restore Discord before deleting the manager and abort if restoration fails. Manager upgrades must not restore Discord.
15. Bind the flavour-specific local gateway relay before loading Discord. Accept only domain-form `discord.gg` targets on port 443 and return SOCKS success only after an upstream tunnel exists.
16. Treat Tor as ready only when the exact packaged executable owns the configured loopback listener and an authenticated TLS probe succeeds. Recheck listener ownership asynchronously before and after every upstream tunnel; never block Electron's main thread on PowerShell.
17. Keep the private release key non-exportable in `CurrentUser\\My`. Ship only the pinned public certificate; importing the exact self-signed certificate into `CurrentUser\\Root` requires explicit Windows confirmation, and `TrustedPublisher` limits publisher trust to that signer. Ship and document an authenticated removal path.
18. Sign release executables and the friend trust script with the pinned RSA certificate, but exclude the official `tor.exe` and verify its packaged hash against the manifest after every build.
19. Never disable Smart App Control silently. Reject reparse points in friend artifact paths and hold read-only locks through execution. Change `VerifiedAndReputablePolicyState` from `Enforce` to `Off` only after exact typed consent, recheck the elevated state, refresh with `CiTool`, and leave `Evaluation` unchanged. Attempt and verify rollback and trust cleanup on any failed helper run, report when either cannot be confirmed, and retain trust after the helper completes successfully so repair and uninstall remain possible.

## Runtime Layout

- `runtime/payload.cjs`: code loaded by Discord before its original main module.
- `runtime/proxy.pac`: protected-host routing rule. Protected results must contain one SOCKS endpoint and no fallback separator.
- `runtime/gateway-relay.cjs`: loopback SOCKS boundary that admits only protected Gateway targets after Tor ownership and readiness checks.
- `runtime/runtime-safety.cjs`: path-confinement and Windows process-identity checks shared with the injected payload.
- `vendor/tor/`: generated, ignored files from the pinned official Tor archive.
- `vendor/tor-manifest.json`: generated hashes for every packaged Tor file.
- Development reads the split `runtime/` and `vendor/` trees; packaging merges them into one verified runtime.
- `%LOCALAPPDATA%\GoLiveBypassSafe\runtime`: stable runtime copied by the manager.
- `%LOCALAPPDATA%\GoLiveBypassSafe\transactions`: append-only transaction journals.
- `%LOCALAPPDATA%\GoLiveBypassSafe\backups`: external original `app.asar` copies.
- `GoLiveBypassSafeSetup.exe`: versionless per-user NSIS installer with shortcuts and restore-before-uninstall behavior.
- `GoLiveBypassSafePortable.exe`: versionless emergency recovery manager.
- `Trust-GoLiveBypassSafe.ps1` and `GoLiveBypassSafe.cer`: signed friend bootstrap and public certificate. Authenticate the stable certificate hash and thumbprint out of band, import that exact certificate, and verify the script signature before bypassing execution policy.

## Required Verification

Run these after changes:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run prepare:tor
npm.cmd run probe:tor
npm.cmd run compile
npm.cmd run build:private
```

For routing changes, inspect `runtime/proxy.pac` and the relay. Keep tests for canonical, regional, remote-auth, trailing-dot, unrelated, suffix-confusion, malformed SOCKS, delayed Tor, and unauthorized listener cases.

For Tor runtime changes, run the isolated network probe and verify the packaged fuse state. The probe must never start, stop, or modify Discord.

For installation changes, test normal install/uninstall, v0.1.0 migration and direct restore, foreign-loader refusal, failure after moving the original, and failure after committing the loader.

For packaging changes, test both artifacts, install per-user, verify shortcuts, uninstall with an active loader, and confirm a manager upgrade does not restore Discord.

For signing changes, verify the exact signer on the setup, portable app, unpacked manager, and trust script. Confirm the public certificate has no private key, the trust script rejects substitutions, and packaged `tor.exe` remains byte-identical to the pinned manifest.

## Documentation

Update this skill's `metadata.updated`, `README.md`, and relevant tests whenever an invariant, runtime path, recovery phase, build input, or security boundary changes.
