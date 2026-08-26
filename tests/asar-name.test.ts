import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("renamed Discord archive", () => {
  it("remains mountable by Electron", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-asar-name-test-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "original");
    const testApp = path.join(root, "test-app");
    const archive = path.join(root, "app.golive-original.asar");
    fs.mkdirSync(source);
    fs.mkdirSync(testApp);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ marker: "discord-original" }));
    await createPackage(source, archive);
    fs.writeFileSync(path.join(testApp, "package.json"), JSON.stringify({ name: "asar-name-test", main: "index.cjs" }));
    fs.writeFileSync(
      path.join(testApp, "index.cjs"),
      [
        'const { app } = require("electron");',
        'const path = require("node:path");',
        'const original = require(path.join(process.env.GOLIVE_TEST_ASAR, "package.json"));',
        'if (original.marker !== "discord-original") process.exitCode = 1;',
        "app.quit();",
      ].join("\n"),
    );

    const result = spawnSync(electronPath, [testApp], {
      encoding: "utf8",
      env: { ...process.env, GOLIVE_TEST_ASAR: archive },
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 45_000);
});
