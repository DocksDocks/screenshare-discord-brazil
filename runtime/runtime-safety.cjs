"use strict";

const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function resolveContainedFile(root, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new Error("invalid runtime path");
  }
  const portableName = name.replaceAll("\\", "/");
  const segments = portableName.split("/");
  if (
    portableName.startsWith("/") ||
    /^[a-z]:/i.test(portableName) ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("invalid runtime path");
  }
  const resolvedRoot = path.resolve(root);
  if (fs.lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("runtime root links are not allowed");
  const file = path.resolve(resolvedRoot, ...segments);
  const physicalRoot = fs.realpathSync.native(resolvedRoot);
  const physicalFile = fs.realpathSync.native(file);
  const relative = path.relative(physicalRoot, physicalFile);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("runtime path escapes its root");
  }
  return physicalFile;
}

function listContainedFiles(root, current = root) {
  if (fs.lstatSync(path.resolve(root)).isSymbolicLink()) throw new Error("runtime root links are not allowed");
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("runtime links are not allowed");
    const file = path.join(current, entry.name);
    const name = path.relative(root, file).replaceAll("\\", "/");
    resolveContainedFile(root, name);
    if (entry.isDirectory()) return listContainedFiles(root, file);
    if (entry.isFile()) return [name];
    throw new Error("unsupported runtime entry");
  });
}

function processMatchesExecutable(pid, expectedExecutable) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof expectedExecutable !== "string") return false;
  const script = [
    `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -ne $candidate) { [Console]::Out.Write($candidate.ExecutablePath) }",
  ].join("; ");
  try {
    const actualExecutable = execFileSync(
      POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).trim();
    return actualExecutable.length > 0 && path.resolve(actualExecutable).toLowerCase() === path.resolve(expectedExecutable).toLowerCase();
  } catch {
    return false;
  }
}

function processOwnsLoopbackTcpListener(pid, expectedExecutable, port) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof expectedExecutable !== "string" ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    return Promise.resolve(false);
  }
  const script = [
    `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    `$listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ${port} -OwningProcess ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -ne $candidate -and $null -ne $listener) { [Console]::Out.Write($candidate.ExecutablePath) }",
  ].join("; ");
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error !== null) return resolve(false);
        const actualExecutable = stdout.trim();
        resolve(
          actualExecutable.length > 0 &&
            path.resolve(actualExecutable).toLowerCase() === path.resolve(expectedExecutable).toLowerCase(),
        );
      },
    );
  });
}

module.exports = { listContainedFiles, processMatchesExecutable, processOwnsLoopbackTcpListener, resolveContainedFile };
