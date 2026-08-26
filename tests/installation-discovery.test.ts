import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverAllDiscordTargets,
  discoverDiscordTargets,
} from "../electron/installation.js";
import {
  cleanupTemporaryDirectories,
  fakeDiscord,
  temporaryDirectory,
} from "./installation-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("Discord discovery", () => {
  it("selects numeric versions instead of lexical order", () => {
    const root = temporaryDirectory();
    fakeDiscord(root, "1.0.99");
    fakeDiscord(root, "1.0.100");
    expect(discoverDiscordTargets(root)).toHaveLength(1);
    expect(discoverDiscordTargets(root)[0]?.version).toBe("1.0.100");
    expect(discoverAllDiscordTargets(root).map((target) => target.version)).toEqual(["1.0.99", "1.0.100"]);
  });

  it("rejects a junction used as a Discord root", () => {
    if (process.platform !== "win32") return;
    const root = temporaryDirectory();
    const physicalLocalAppData = path.join(root, "physical");
    fakeDiscord(physicalLocalAppData);
    fs.symlinkSync(path.join(physicalLocalAppData, "Discord"), path.join(root, "Discord"), "junction");

    expect(() => discoverDiscordTargets(root)).toThrow(/Link|nova analise/);
  });
});
