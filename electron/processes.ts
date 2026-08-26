import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiscordTarget } from "./installation.js";

interface WindowsProcess {
  ProcessId: number;
  ExecutablePath: string | null;
  CreationTimeMs: number;
}

const WMI_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 45_000;

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function normalized(file: string): string {
  return path.resolve(file).replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function windowsProcess(value: unknown): WindowsProcess | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ProcessId" in value) ||
    !Number.isSafeInteger(value.ProcessId) ||
    (value.ProcessId as number) <= 0 ||
    !("ExecutablePath" in value) ||
    (typeof value.ExecutablePath !== "string" && value.ExecutablePath !== null) ||
    !("CreationTimeMs" in value) ||
    !Number.isSafeInteger(value.CreationTimeMs) ||
    (value.CreationTimeMs as number) < 0
  ) {
    return null;
  }
  return {
    ProcessId: value.ProcessId as number,
    ExecutablePath: value.ExecutablePath,
    CreationTimeMs: value.CreationTimeMs as number,
  };
}

function parseProcessOutput(output: string): WindowsProcess[] {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("Success" in parsed) ||
    parsed.Success !== true ||
    !("Processes" in parsed) ||
    !Array.isArray(parsed.Processes)
  ) {
    throw new Error("A consulta de processos do Windows nao confirmou a conclusao.");
  }
  const values = parsed.Processes;
  const processes = values.map(windowsProcess);
  if (processes.some((candidate) => candidate === null)) {
    throw new Error("A consulta de processos do Windows retornou dados invalidos.");
  }
  return processes as WindowsProcess[];
}

function discordProcesses(): WindowsProcess[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$names = @('Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe', 'Update.exe')",
    "$processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $names -contains $_.Name } | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ExecutablePath = $_.ExecutablePath; CreationTimeMs = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } })",
    "[pscustomobject]@{ Success = $true; Processes = @($processes) } | ConvertTo-Json -Depth 3 -Compress",
  ].join("; ");
  const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: WMI_TIMEOUT_MS,
    windowsHide: true,
  }).trim();
  return parseProcessOutput(output);
}

function processById(processId: number): WindowsProcess | null {
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$candidate = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${processId}"`,
    "$processes = @()",
    "if ($null -ne $candidate) { $processes = @([pscustomobject]@{ ProcessId = [int]$candidate.ProcessId; ExecutablePath = $candidate.ExecutablePath; CreationTimeMs = ([DateTimeOffset]$candidate.CreationDate).ToUnixTimeMilliseconds() }) }",
    "[pscustomobject]@{ Success = $true; Processes = @($processes) } | ConvertTo-Json -Depth 3 -Compress",
  ].join("; ");
  const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: WMI_TIMEOUT_MS,
    windowsHide: true,
  }).trim();
  const candidates = parseProcessOutput(output);
  if (candidates.length === 0) return null;
  if (candidates.length !== 1 || candidates[0]!.ProcessId !== processId) {
    throw new Error("A consulta de identidade do processo retornou dados invalidos.");
  }
  return candidates[0]!;
}

interface TerminationResult {
  status: "ok" | "mismatch" | "error";
  killed: number[];
}

function terminateExactProcesses(
  candidates: Array<{ process: WindowsProcess; executablePath: string }>,
): TerminationResult {
  if (candidates.length === 0) return { status: "ok", killed: [] };
  const specs = candidates.map(({ process: candidate, executablePath }) => ({
    ProcessId: candidate.ProcessId,
    ExecutablePath: executablePath,
    CreationTimeMs: candidate.CreationTimeMs,
  }));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$specs = @($env:GOLIVE_PROCESS_SPECS | ConvertFrom-Json)",
    "$opened = @()",
    "foreach ($spec in $specs) {",
    "  try { $candidate = Get-Process -Id ([int]$spec.ProcessId) -ErrorAction Stop; $null = $candidate.Handle } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { continue } catch { [pscustomobject]@{ Status = 'error'; Killed = @() } | ConvertTo-Json -Compress; exit 0 }",
    "  $actualPath = [IO.Path]::GetFullPath($candidate.Path)",
    "  $expectedPath = [IO.Path]::GetFullPath([string]$spec.ExecutablePath)",
    "  $created = ([DateTimeOffset]$candidate.StartTime).ToUnixTimeMilliseconds()",
    "  if (-not [String]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or $created -ne [long]$spec.CreationTimeMs) { [pscustomobject]@{ Status = 'mismatch'; Killed = @() } | ConvertTo-Json -Compress; exit 0 }",
    "  $opened += [pscustomobject]@{ Process = $candidate; ProcessId = [int]$spec.ProcessId }",
    "}",
    "$killed = @()",
    "$failed = $false",
    "foreach ($entry in $opened) { try { if (-not $entry.Process.HasExited) { $entry.Process.Kill() }; if (-not $entry.Process.WaitForExit(10000) -and -not $entry.Process.HasExited) { throw 'process termination timeout' }; $killed += $entry.ProcessId } catch { try { if ($entry.Process.HasExited) { $killed += $entry.ProcessId; continue } } catch {}; $failed = $true; break } }",
    "if ($failed) { [pscustomobject]@{ Status = 'error'; Killed = @($killed) } | ConvertTo-Json -Compress; exit 0 }",
    "[pscustomobject]@{ Status = 'ok'; Killed = @($killed) } | ConvertTo-Json -Compress",
  ].join("\n");
  const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, GOLIVE_PROCESS_SPECS: JSON.stringify(specs) },
    timeout: TERMINATION_TIMEOUT_MS,
    windowsHide: true,
  }).trim();
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("Status" in value) ||
    !["ok", "mismatch", "error"].includes(String(value.Status)) ||
    !("Killed" in value)
  ) {
    throw new Error("O encerramento de processos retornou dados invalidos.");
  }
  const rawKilled = Array.isArray(value.Killed) ? value.Killed : value.Killed === null ? [] : [value.Killed];
  if (rawKilled.some((processId) => !Number.isSafeInteger(processId) || processId <= 0)) {
    throw new Error("O encerramento de processos retornou PIDs invalidos.");
  }
  return { status: value.Status as TerminationResult["status"], killed: rawKilled as number[] };
}

function matchingProcesses(targets: DiscordTarget[]): WindowsProcess[] {
  const executablePaths = new Set(
    targets.flatMap((target) => [
      normalized(target.executablePath),
      normalized(path.join(path.dirname(path.dirname(target.resourcesPath)), "Update.exe")),
    ]),
  );
  return discordProcesses().filter(
    (candidate) =>
      typeof candidate.ExecutablePath === "string" &&
      executablePaths.has(normalized(candidate.ExecutablePath)),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopDiscord(targets: DiscordTarget[]): Promise<Set<string>> {
  const processes = matchingProcesses(targets);
  const planned = processes.flatMap((candidate) => {
    if (candidate.ExecutablePath === null) return [];
    const target = targets.find(
      (item) =>
        normalized(item.executablePath) === normalized(candidate.ExecutablePath!) ||
        normalized(path.join(path.dirname(path.dirname(item.resourcesPath)), "Update.exe")) ===
          normalized(candidate.ExecutablePath!),
    );
    if (target === undefined) return [];
    const restart = normalized(target.executablePath) === normalized(candidate.ExecutablePath);
    const executablePath = restart
      ? target.executablePath
      : path.join(path.dirname(path.dirname(target.resourcesPath)), "Update.exe");
    return [{ process: candidate, executablePath, restart, target }];
  });
  const result = terminateExactProcesses(planned);
  if (result.status === "mismatch") {
    throw new Error("O PID do Discord foi reutilizado; o novo processo nao foi encerrado.");
  }
  const killed = new Set(result.killed);
  const running = new Set(
    planned
      .filter(
        ({ process: candidate, executablePath, restart }) =>
          restart &&
          killed.has(candidate.ProcessId) &&
          planned.every(
            (other) =>
              !other.restart ||
              normalized(other.executablePath) !== normalized(executablePath) ||
              killed.has(other.process.ProcessId),
          ),
      )
      .map(({ executablePath }) => executablePath),
  );
  if (result.status === "error") {
    restartDiscord(running);
    throw new Error("O Windows nao conseguiu encerrar todos os processos Discord validados.");
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (matchingProcesses(targets).length === 0) return running;
    await delay(250);
  }
  restartDiscord(running);
  throw new Error("O Discord nao fechou. Feche-o manualmente e tente de novo.");
}

export function restartDiscord(previouslyRunning: Set<string>): void {
  const activeProcesses = discordProcesses();
  if (activeProcesses.some((candidate) => candidate.ExecutablePath === null)) return;
  const activePaths = new Set(activeProcesses.map((candidate) => normalized(candidate.ExecutablePath!)));
  for (const executablePath of previouslyRunning) {
    const executableKey = normalized(executablePath);
    if (activePaths.has(executableKey)) continue;
    spawn(executablePath, [], { detached: false, stdio: "ignore", windowsHide: true }).unref();
    activePaths.add(executableKey);
  }
}

export async function stopManagedTor(dataRoot: string): Promise<void> {
  const pidPath = path.join(dataRoot, "tor-state", "tor.pid");
  if (!fs.existsSync(pidPath)) return;
  const processId = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("O arquivo de PID do Tor gerenciado e invalido e foi preservado.");
  }
  const candidate = processById(processId);
  if (candidate === null) {
    fs.rmSync(pidPath, { force: true });
    return;
  }
  const expectedPath = path.join(dataRoot, "runtime", "tor", "tor", "tor.exe");
  if (candidate.ExecutablePath === null || normalized(candidate.ExecutablePath) !== normalized(expectedPath)) {
    throw new Error("O PID salvo do Tor pertence a outro programa; ele nao foi encerrado.");
  }
  const result = terminateExactProcesses([{ process: candidate, executablePath: expectedPath }]);
  if (result.status === "mismatch") {
    throw new Error("O PID salvo do Tor foi reutilizado; o novo processo nao foi encerrado.");
  }
  if (result.status === "error") {
    throw new Error("O Windows nao conseguiu encerrar o processo Tor validado.");
  }
  fs.rmSync(pidPath, { force: true });
}
