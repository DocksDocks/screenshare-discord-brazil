import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTarget,
  withInstallationLock,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  installedFixture,
  journalPath,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("installation operation lock", () => {
  it("rejects a concurrent manager or uninstall helper", async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = withInstallationLock(
      () =>
        new Promise<void>((resolve) => {
          entered();
          release = resolve;
        }),
    );
    await new Promise<void>((resolve) => {
      entered = resolve;
    });

    const client = net.createConnection("\\\\.\\pipe\\golivebypass-safe-installation-v1");
    await new Promise<void>((resolve, reject) => {
      client.once("close", () => resolve());
      client.once("error", reject);
    });

    await expect(withInstallationLock(() => undefined)).rejects.toThrow(/Outra operacao/);
    release();
    await Promise.race([
      active,
      new Promise((_, reject) => setTimeout(() => reject(new Error("installation lock did not close")), 1000)),
    ]);
  });

  it("creates the first journal exclusively without replacing pending evidence", () => {
    const root = temporaryDirectory();
    const { dataRoot, payload, target, transaction } = installedFixture(root);
    fs.writeFileSync(path.join(transaction.livePath, "index.js"), "modified\n");
    const journal = journalPath(dataRoot, transaction.id);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, "pending evidence\n");

    expect(() => installTarget(target, dataRoot, payload)).toThrow();
    expect(fs.readFileSync(journal, "utf8")).toBe("pending evidence\n");
  });
});
