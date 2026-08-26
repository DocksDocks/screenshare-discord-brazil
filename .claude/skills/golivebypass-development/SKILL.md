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
14. A normal NSIS uninstall must refuse to continue while the manager is open, restore Discord before deleting the manager, and abort if restoration fails. NSIS must never terminate processes or execute an old registered uninstaller; verify and remove that exact block from the pinned electron-builder template only for the duration of a build, and restore the dependency bytes in `finally`. Release upgrades are explicit restore-and-uninstall operations.
15. Bind the flavour-specific local gateway relay before loading Discord. Accept only domain-form `discord.gg` targets on port 443 and return SOCKS success only after an upstream tunnel exists.
16. Treat Tor as ready only when the exact packaged executable owns the configured loopback listener and an authenticated TLS probe succeeds. Recheck listener ownership asynchronously before and after every upstream tunnel; never block Electron's main thread on PowerShell.
17. Releases are intentionally unsigned. Require users to authenticate the top-level ZIP SHA-256 through the GitHub release or another independent channel; internal checksums detect extraction corruption but are not an independent trust root. Do not add certificates, trust-store mutation, or signing secrets.
18. Require Smart App Control to be `Off` or unavailable before installation. Never change SAC automatically; users disable and re-enable it through Windows Security. Keep the controller unelevated and reject `Enforce` and `Evaluation` before Setup starts.
19. Deliberately launching `Install-GoLiveBypassSafe.bat` is consent. Reject reparse points, serialize controller runs across sessions with a global named mutex, hold read-only artifact locks, force Setup to the fixed per-user directory, confirm its install and uninstall registrations through both NSIS registry views, require the exact Setup hash and complete manager-tree hash, and re-enumerate the locked tree immediately before install and rollback. Reuse an existing manager only when its tree, uninstaller path, and registrations exactly match the current release; require older or incomplete installations to be removed before Setup so NSIS cannot execute an unauthenticated old uninstaller. Never terminate a process or restore Discord unless the launched process identity and complete tree termination were confirmed, never execute the excluded uninstaller during automatic rollback, and preserve the installed manager, registry, and shortcuts after every failed Setup attempt for explicit recovery or uninstall.
20. Release builds require synchronized `0.2.5` metadata, pinned Node.js 24.18.0 and npm 11.16.0, a clean worktree, and an annotated version tag at `HEAD`. Explicit dirty builds are development-only and must record that state. Reinstall the locked dependency tree with an explicit install-script policy, clean stale output, and verify embedded version, Electron fuses, complete runtime/Tor contents, source provenance, hashes, and the exact final artifact set. Produce and retain only a deterministic versioned ZIP, then recheck every bundled entry against its source hash. Stage Tor extraction under `vendor` so verified promotion is an atomic same-volume rename, and preserve the checked-out pinned manifest when its normalized content already matches the verified bundle. Packaging scripts invoked through Windows PowerShell must compute SHA-256 directly with .NET instead of depending on PowerShell module autoloading.
21. Keep CI and release workflows separate. Pull requests and branch pushes use read-only permissions. Tag releases run only on GitHub-hosted Windows runners, require the tagged commit to remain reachable from `main`, pin every action to its reviewed repository and full commit SHA, disable checkout credential persistence, enforce timeouts and concurrency, upload only the ZIP, and validate the uploaded asset state, digest, and remote tag immediately before and after publication. Publish with semantic-version-aware latest-release selection and return the release to draft if post-publication validation fails.

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
- `Install-GoLiveBypassSafe.ps1`: unsigned unelevated controller with release-bound Setup and manager-tree hashes.
- `GoLiveBypassSafe-vX.Y.Z.zip`: sole release asset; deterministic bundle containing Setup, controller, launcher, provenance, and checksums.

## Required Verification

Run these after changes:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run prepare:tor
npm.cmd run probe:tor
npm.cmd run compile
npm.cmd run build:release
```

For routing changes, inspect `runtime/proxy.pac` and the relay. Keep tests for canonical, regional, remote-auth, trailing-dot, unrelated, suffix-confusion, malformed SOCKS, delayed Tor, and unauthorized listener cases.

For Tor runtime changes, run the isolated network probe and verify the packaged fuse state. The probe must never start, stop, or modify Discord.

For installation changes, test normal install/uninstall, v0.1.0 migration and direct restore, foreign-loader refusal, failure after moving the original, and failure after committing the loader.

For packaging changes, test the per-user installer, verify shortcuts, require a ZIP-only final release directory, uninstall with an active loader, and confirm a manager upgrade does not restore Discord.

For release-authentication changes, keep executable signing explicitly disabled, reject certificate/trust infrastructure, verify the Setup and complete manager tree before execution, and keep packaged `tor.exe` byte-identical to the pinned manifest.

For SAC changes, verify that `Enforce` and `Evaluation` stop before Setup, while `Off` and unavailable states proceed without registry mutation or elevation. Document manual re-enablement after install, repair, and uninstall.

## Documentation

Update this skill's `metadata.updated`, `README.md`, and relevant tests whenever an invariant, runtime path, recovery phase, build input, or security boundary changes.
