import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordTarget } from "../electron/installation.js";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { restartDiscord, stopDiscord, stopManagedTor } from "../electron/processes.js";

const temporaryDirectories: string[] = [];

function processQuery(...processes: Array<Record<string, unknown>>): string {
  return JSON.stringify({ Success: true, Processes: processes });
}

afterEach(() => {
  childProcessMocks.execFileSync.mockReset();
  childProcessMocks.spawn.mockReset();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("process identity revalidation", () => {
  it("refuses a reused Discord PID before terminating any validated process", async () => {
    const target: DiscordTarget = {
      flavour: "Discord",
      version: "1.0.100",
      resourcesPath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\resources",
      executablePath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\Discord.exe",
    };
    childProcessMocks.execFileSync
      .mockReturnValueOnce(
        processQuery({ ProcessId: 4242, ExecutablePath: target.executablePath, CreationTimeMs: 1000 }),
      )
      .mockReturnValueOnce(
        JSON.stringify({ Status: "mismatch", Killed: [] }),
      );

    await expect(stopDiscord([target])).rejects.toThrow(/reutilizado/);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2);
    expect(childProcessMocks.execFileSync.mock.calls[1]?.[2]).toMatchObject({ timeout: 45_000 });
    const terminationScript = String(
      (childProcessMocks.execFileSync.mock.calls[1]?.[1] as string[] | undefined)?.[4],
    );
    expect(terminationScript).toContain(
      "FullyQualifiedErrorId -ceq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand'",
    );
    expect(terminationScript).toContain("$parsedSpecs = ConvertFrom-Json -InputObject $env:GOLIVE_PROCESS_SPECS");
    expect(terminationScript).toContain("$specs = @($parsedSpecs)");
    expect(terminationScript).not.toContain("@($env:GOLIVE_PROCESS_SPECS | ConvertFrom-Json)");
    expect(terminationScript).not.toContain("[Microsoft.PowerShell.Commands.ProcessCommandException]");
  });

  it("refuses a reused managed Tor PID immediately before kill", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golive-process-test-"));
    temporaryDirectories.push(dataRoot);
    const pidPath = path.join(dataRoot, "tor-state", "tor.pid");
    const expectedPath = path.join(dataRoot, "runtime", "tor", "tor", "tor.exe");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, "5151\n");
    childProcessMocks.execFileSync
      .mockReturnValueOnce(processQuery({ ProcessId: 5151, ExecutablePath: expectedPath, CreationTimeMs: 1000 }))
      .mockReturnValueOnce(JSON.stringify({ Status: "mismatch", Killed: [] }));

    await expect(stopManagedTor(dataRoot)).rejects.toThrow(/reutilizado/);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2);
    expect(childProcessMocks.execFileSync.mock.calls[1]?.[2]).toMatchObject({ timeout: 45_000 });
  });

  it("preserves a malformed managed Tor PID file without querying or killing", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golive-process-test-"));
    temporaryDirectories.push(dataRoot);
    const pidPath = path.join(dataRoot, "tor-state", "tor.pid");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, "not-a-pid\n");

    await expect(stopManagedTor(dataRoot)).rejects.toThrow(/PID.*invalido/);
    expect(fs.readFileSync(pidPath, "utf8")).toBe("not-a-pid\n");
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed non-empty process query", async () => {
    const target: DiscordTarget = {
      flavour: "Discord",
      version: "1.0.100",
      resourcesPath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\resources",
      executablePath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\Discord.exe",
    };
    childProcessMocks.execFileSync.mockReturnValueOnce(processQuery({ ProcessId: 4242 }));

    await expect(stopDiscord([target])).rejects.toThrow(/dados invalidos/);
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("restarts only exact executables whose processes were all stopped before a partial failure", async () => {
    const targets: DiscordTarget[] = [
      {
        flavour: "Discord",
        version: "1.0.99",
        resourcesPath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.99\\resources",
        executablePath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.99\\Discord.exe",
      },
      {
        flavour: "Discord",
        version: "1.0.100",
        resourcesPath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\resources",
        executablePath: "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\Discord.exe",
      },
    ];
    childProcessMocks.execFileSync
      .mockReturnValueOnce(
        processQuery(
          { ProcessId: 4242, ExecutablePath: targets[0]!.executablePath, CreationTimeMs: 1000 },
          { ProcessId: 4343, ExecutablePath: targets[1]!.executablePath, CreationTimeMs: 2000 },
          { ProcessId: 4444, ExecutablePath: targets[1]!.executablePath, CreationTimeMs: 3000 },
        ),
      )
      .mockReturnValueOnce(JSON.stringify({ Status: "error", Killed: [4242, 4343] }))
      .mockReturnValueOnce(processQuery());
    childProcessMocks.spawn.mockReturnValue({ unref: vi.fn() });

    await expect(stopDiscord(targets)).rejects.toThrow(/todos os processos/);
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      targets[0]!.executablePath,
      [],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(String((childProcessMocks.execFileSync.mock.calls[1]?.[1] as string[] | undefined)?.[4])).toContain(
      "HasExited",
    );
  });

  it("does not restart an executable that reappeared after termination", () => {
    const executablePath = "C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.100\\Discord.exe";
    childProcessMocks.execFileSync.mockReturnValueOnce(
      processQuery({ ProcessId: 4545, ExecutablePath: executablePath, CreationTimeMs: 4000 }),
    );

    restartDiscord(new Set([executablePath]));

    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});
