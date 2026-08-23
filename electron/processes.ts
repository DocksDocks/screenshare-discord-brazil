import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiscordTarget } from "./installation.js";

interface WindowsProcess {
  ProcessId: number;
  ExecutablePath: string | null;
}

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function normalized(file: string): string {
  return path.resolve(file).toLowerCase();
}

function discordProcesses(): WindowsProcess[] {
  const script = [
    "$names = @('Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe')",
    "@(Get-CimInstance -ClassName Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object ProcessId, ExecutablePath) | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (output === "" || output === "null") return [];
  const parsed = JSON.parse(output) as WindowsProcess | WindowsProcess[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processById(processId: number): WindowsProcess | null {
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;
  const script = `Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${processId}" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`;
  const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return output === "" || output === "null" ? null : (JSON.parse(output) as WindowsProcess);
}

function matchingProcesses(targets: DiscordTarget[]): WindowsProcess[] {
  const executablePaths = new Set(targets.map((target) => normalized(target.executablePath)));
  return discordProcesses().filter(
    (candidate) =>
      typeof candidate.ProcessId === "number" &&
      typeof candidate.ExecutablePath === "string" &&
      executablePaths.has(normalized(candidate.ExecutablePath)),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopDiscord(targets: DiscordTarget[]): Promise<Set<DiscordTarget["flavour"]>> {
  const processes = matchingProcesses(targets);
  const running = new Set<DiscordTarget["flavour"]>();
  for (const candidate of processes) {
    const target = targets.find(
      (item) => candidate.ExecutablePath !== null && normalized(item.executablePath) === normalized(candidate.ExecutablePath),
    );
    if (target !== undefined) running.add(target.flavour);
    process.kill(candidate.ProcessId);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (matchingProcesses(targets).length === 0) return running;
    await delay(250);
  }
  throw new Error("O Discord nao fechou. Feche-o manualmente e tente de novo.");
}

export function restartDiscord(targets: DiscordTarget[], previouslyRunning: Set<DiscordTarget["flavour"]>): void {
  for (const target of targets) {
    if (!previouslyRunning.has(target.flavour)) continue;
    spawn(target.executablePath, [], { detached: false, stdio: "ignore", windowsHide: true }).unref();
  }
}

export async function stopManagedTor(dataRoot: string): Promise<void> {
  const pidPath = path.join(dataRoot, "tor-state", "tor.pid");
  if (!fs.existsSync(pidPath)) return;
  const processId = Number(fs.readFileSync(pidPath, "utf8").trim());
  const candidate = processById(processId);
  if (candidate === null) {
    fs.rmSync(pidPath, { force: true });
    return;
  }
  const expectedPath = path.join(dataRoot, "runtime", "tor", "tor", "tor.exe");
  if (candidate.ExecutablePath === null || normalized(candidate.ExecutablePath) !== normalized(expectedPath)) {
    throw new Error("O PID salvo do Tor pertence a outro programa; ele nao foi encerrado.");
  }
  process.kill(processId);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (processById(processId) === null) {
      fs.rmSync(pidPath, { force: true });
      return;
    }
    await delay(100);
  }
  throw new Error("O processo Tor gerenciado nao encerrou.");
}
