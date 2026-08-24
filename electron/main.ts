import { app, BrowserWindow, ipcMain, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverDiscordTargets,
  inspectTarget,
  installTarget,
  installedRecords,
  recoverTransactions,
  uninstallAll,
  type DiscordTarget,
} from "./installation.js";
import { restartDiscord, stopDiscord, stopManagedTor } from "./processes.js";
import { prepareRuntime, runtimeSourceReady } from "./runtime.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const isWindows = process.platform === "win32";
let mainWindow: BrowserWindow | null = null;

function localAppData(): string {
  const value = process.env.LOCALAPPDATA;
  if (!value) throw new Error("LOCALAPPDATA nao esta definido.");
  return value;
}

function dataRoot(): string {
  return path.join(localAppData(), "GoLiveBypassSafe");
}

function sourceRuntime(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "runtime") : projectRoot;
}

function currentTargets(): DiscordTarget[] {
  return discoverDiscordTargets(localAppData());
}

function overview(message = ""): Record<string, unknown> {
  const targets = isWindows ? currentTargets() : [];
  return {
    supported: isWindows,
    runtimeReady: runtimeSourceReady(sourceRuntime()),
    message,
    channels: targets.map((target) => inspectTarget(target)),
  };
}

async function assertDirectSystemRoute(): Promise<void> {
  const results = await Promise.all([
    session.defaultSession.resolveProxy("https://discord.com"),
    session.defaultSession.resolveProxy("https://cdn.discordapp.com"),
    session.defaultSession.resolveProxy("https://www.google.com"),
  ]);
  if (!results.every((result) => result === "DIRECT")) {
    throw new Error("Proxy ou PAC do sistema detectado. A instalacao foi recusada para nao substituir essa politica.");
  }
}

async function installOrRepair(): Promise<Record<string, unknown>> {
  if (!isWindows) throw new Error("Esta versao segura suporta somente Windows.");
  if (!runtimeSourceReady(sourceRuntime())) {
    throw new Error("O runtime Tor verificado nao esta empacotado. Execute npm run prepare:tor antes do build.");
  }
  await assertDirectSystemRoute();
  const targets = currentTargets();
  if (targets.length === 0) throw new Error("Nenhuma instalacao do Discord foi encontrada.");

  const previouslyRunning = await stopDiscord(targets);
  try {
    recoverTransactions(dataRoot());
    await stopManagedTor(dataRoot());
    const payloadPath = prepareRuntime(sourceRuntime(), dataRoot());
    const installed: string[] = [];
    const refused: string[] = [];
    for (const target of targets) {
      const status = inspectTarget(target);
      if (status.state === "foreign") {
        refused.push(target.flavour);
        continue;
      }
      if (status.state === "broken") {
        throw new Error(`${target.flavour}: estado incompleto sem transacao recuperavel.`);
      }
      installTarget(target, dataRoot(), payloadPath);
      installed.push(target.flavour);
    }
    if (installed.length === 0) {
      throw new Error(`Nada foi alterado. Modificador preservado em: ${refused.join(", ")}.`);
    }
    const suffix = refused.length === 0 ? "" : ` Outro modificador foi preservado em: ${refused.join(", ")}.`;
    return overview(`Pronto em ${installed.join(", ")}.${suffix}`);
  } finally {
    restartDiscord(targets, previouslyRunning);
  }
}

async function restoreOriginalInstallations(): Promise<string[]> {
  if (!isWindows) throw new Error("Esta versao segura suporta somente Windows.");
  const current = currentTargets();
  const known = installedRecords(dataRoot()).map((record) => ({
    flavour: record.flavour,
    version: record.version,
    resourcesPath: record.resourcesPath,
    executablePath: record.executablePath,
  }));
  const targets = [...current, ...known].filter(
    (target, index, all) => all.findIndex((other) => other.executablePath === target.executablePath) === index,
  );
  const previouslyRunning = await stopDiscord(targets);
  try {
    recoverTransactions(dataRoot());
    await stopManagedTor(dataRoot());
    return uninstallAll(dataRoot(), current);
  } finally {
    restartDiscord(current, previouslyRunning);
  }
}

async function uninstall(): Promise<Record<string, unknown>> {
  const restored = await restoreOriginalInstallations();
  return overview(restored.length === 0 ? "Nenhuma instalacao nossa foi encontrada." : `Restaurado: ${restored.join(", ")}.`);
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (mainWindow === null || event.sender !== mainWindow.webContents) throw new Error("Origem IPC recusada.");
}

function registerIpc(): void {
  ipcMain.handle("golive:status", (event) => {
    assertTrustedSender(event);
    return overview();
  });
  ipcMain.handle("golive:install", async (event) => {
    assertTrustedSender(event);
    return installOrRepair();
  });
  ipcMain.handle("golive:repair", async (event) => {
    assertTrustedSender(event);
    return installOrRepair();
  });
  ipcMain.handle("golive:uninstall", async (event) => {
    assertTrustedSender(event);
    return uninstall();
  });
  ipcMain.handle("golive:license", (event) => {
    assertTrustedSender(event);
    const licensePath = app.isPackaged ? path.join(process.resourcesPath, "LICENSE") : path.join(projectRoot, "LICENSE");
    return fs.readFileSync(licensePath, "utf8");
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 680,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0d100e",
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadFile(path.join(projectRoot, "dist", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (process.argv.includes("--restore-before-uninstall")) {
  app.whenReady().then(async () => {
    try {
      await restoreOriginalInstallations();
      app.exit(0);
    } catch {
      app.exit(1);
    }
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpc();
    createWindow();
  });
}

app.on("window-all-closed", () => app.quit());
