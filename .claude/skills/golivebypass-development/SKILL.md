---
name: golivebypass-development
description: Use when changing the GoLiveBypass Safe installer, Discord injection, Tor runtime, PAC routing, packaging, or recovery tests. Not for unrelated project administration.
user-invocable: false
metadata:
  updated: "2026-08-26"
---

# GoLiveBypass Safe Development

## Invariants

1. Support Windows only unless a separately audited platform implementation is added.
2. Route protected `discord.gg` hosts through the owned Tor runtime with no `DIRECT` fallback.
3. Do not add free proxies, remote bootstrap scripts, auto-update, Discord token access, account stores, stream diagnostics, or arbitrary renderer logging.
4. Refuse existing `_app.asar`, directories at `app.asar`, and ownership markers that do not match the canonical resources path.
5. Keep both the renamed original and a SHA-256-verified external backup before committing a loader.
6. Journal filesystem transitions before they happen and keep recovery idempotent.
7. Stop only processes whose path and creation time match a discovered Discord target. Restart only exact executables fully stopped by the operation and still absent immediately before spawn.
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
19. Deliberately launching `Install-GoLiveBypassSafe.bat` is consent; do not add typed or manager confirmations. Reject reparse points and hold read-only artifact locks. Elevate only the fixed signed SAC supervisor, never Setup or manager. Force Setup to a known local directory, confirm it through the fixed NSIS install registration, require the exact build hash of the complete installed application tree and the manager signer, and hold read locks on that tree during headless installation and rollback. Release those locks only before uninstall cleanup, and preserve the installed manager when application restoration fails. Change `VerifiedAndReputablePolicyState` only temporarily from `Enforce` to `Off`, leave `Evaluation` unchanged, and restore the prior state before acknowledging success. Keep automatic installation compensating: confirm termination of timed-out process trees through handles whose PID and creation time both match, restore Discord, remove a manager created by the failed attempt, and accept either success restoration or failure rollback only after registry readback and `CiTool --list-policies` confirm the effective state following `CiTool --refresh`. Under a prior `Enforce` state, the controller must own a per-run named mutex from before helper launch through Setup, manager, and any failure cleanup; the helper must acquire it before restoring SAC, including after controller loss through abandoned ownership. Release it before `COMMIT`, or after cleanup and before `ABORT` if success restoration fails. Treat a verified helper exit after a lost success reply as committed; otherwise report restoration uncertainty distinctly and retain trust only after success.
20. Private release builds require synchronized `0.2.4` metadata, pinned npm 11.16.0, a clean worktree, and an annotated version tag at `HEAD`. Explicit dirty builds are development-only and must record that state. Reinstall the locked dependency tree with an explicit install-script allow/deny policy and dangerous overrides disabled, clean stale output and Electron Builder diagnostics, and verify signatures, embedded version, Electron fuses, complete runtime/Tor contents, unchanged source provenance through the final signing step, and the exact final artifact set without publishing. Produce and retain only a deterministic versioned ZIP with fixed entry order and timestamps, then recheck every bundled entry against its source hash.

## Runtime Layout

- `runtime/payload.cjs`: code loaded by Discord before its original main module.
- `runtime/proxy.pac`: protected-host routing rule. Protected results must contain one SOCKS endpoint and no fallback separator.
- `runtime/gateway-relay.cjs`: loopback SOCKS boundary that admits only protected Gateway targets after Tor ownership and readiness checks.
- `runtime/runtime-safety.cjs`: path-confinement and Windows process-identity checks shared with the injected payload.
- `vendor/tor/`: generated, ignored files from the pinned official Tor archive.
- `vendor/tor-manifest.json`: generated hashes for every packaged Tor file.
- Development reads the split `runtime/` and `vendor/` trees; packaging merges them into one verified runtime.
- `%LOCALAPPDATA%\GoLiveBypassSafe\runtime`: stable runtime copied by the manager.
- `%LOCALAPPDATA%\GoLiveBypassSafe\.runtime-stage` and `.runtime-previous`: fixed recoverable runtime-promotion trees used only while Discord and managed Tor are stopped.
- `%LOCALAPPDATA%\GoLiveBypassSafe\transactions`: append-only transaction journals.
- `%LOCALAPPDATA%\GoLiveBypassSafe\backups`: external original `app.asar` copies.
- `GoLiveBypassSafeSetup.exe`: versionless per-user NSIS installer with shortcuts and restore-before-uninstall behavior.
- `Install-GoLiveBypassSafe.bat`: fixed unelevated launcher; accepts and forwards no arguments.
- `Trust-GoLiveBypassSafe.ps1` and `GoLiveBypassSafe.cer`: signed unprivileged controller and pinned public certificate. The build binds exact release artifact hashes into the controller.
- `Sac-GoLiveBypassSafe.ps1`: the only elevated component; a signed SAC supervisor with a bounded authenticated rollback channel.
- `GoLiveBypassSafe-vX.Y.Z.zip`: sole release asset; deterministic bundle containing Setup, controller, SAC helper, launcher, certificate, provenance, and checksums.

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

For packaging changes, test the per-user installer, verify shortcuts, require a ZIP-only final release directory, uninstall with an active loader, and confirm a manager upgrade does not restore Discord.

For signing changes, verify the exact signer on Setup, the unpacked manager, and the trust scripts. Confirm the public certificate has no private key, the controller rejects substitutions, and packaged `tor.exe` remains byte-identical to the pinned manifest.

For SAC changes, use disposable Windows VMs to verify `Enforce` is restored after successful install, repair, and uninstall; verify `Evaluation`, `Off`, and missing states remain unchanged; and verify every failure path restores the prior configured and effective state.

## Documentation

Update this skill's `metadata.updated`, `README.md`, and relevant tests whenever an invariant, runtime path, recovery phase, build input, or security boundary changes.
