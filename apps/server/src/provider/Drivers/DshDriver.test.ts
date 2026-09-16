/**
 * Update-ownership slice for the DeepSeek Harness driver.
 *
 * `dsh` ships on npm, so a one-click update is only correct when the resolved
 * executable proves an installer owns it. A packaged install yields the npm
 * update command; anything unproven stays manual.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";
import { enrichDshSnapshot } from "../Layers/DshProvider.ts";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  npmGlobalPrefixFromCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

describe("DeepSeek Harness update ownership", () => {
  // The realpath of `<prefix>/bin/dsh` is what proves the installer, because npm
  // links the command to the package's own entry inside `lib/node_modules`.
  it.effect("recognises the npm-owned layout as npm's install", () =>
    Effect.sync(() => {
      expect(
        npmGlobalPrefixFromCommandPath(
          "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
          "@deepseek-ai/dsh",
        ),
      ).toBe("/opt/homebrew");
      expect(
        npmGlobalPrefixFromCommandPath(
          "/Users/me/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
          "@deepseek-ai/dsh",
        ),
      ).toBe("/Users/me/.local");
    }),
  );

  it.effect("does not claim a project-local or unrelated install", () =>
    Effect.sync(() => {
      expect(
        npmGlobalPrefixFromCommandPath(
          "/tmp/checkout/node_modules/@deepseek-ai/dsh/lib/bin.js",
          "@deepseek-ai/dsh",
        ),
      ).toBeNull();
      expect(npmGlobalPrefixFromCommandPath("/usr/local/bin/dsh", "@deepseek-ai/dsh")).toBeNull();
      expect(
        npmGlobalPrefixFromCommandPath(
          "/opt/homebrew/lib/node_modules/other-package/lib/bin.js",
          "@deepseek-ai/dsh",
        ),
      ).toBeNull();
    }),
  );
});

describe("DeepSeek Harness version advisory", () => {
  it.effect("reports a gap between the installed release candidate and the published latest", () =>
    Effect.sync(() => {
      const advisory = createProviderVersionAdvisory({
        driver: "dsh" as never,
        currentVersion: "0.1.2",
        latestVersion: "0.1.5-rc.1",
      });
      expect(advisory.status).toBe("behind_latest");
      expect(advisory.canUpdate).toBe(false);
      expect(advisory.latestVersion).toBe("0.1.5-rc.1");
    }),
  );

  it.effect("offers the update once an installer owns the executable", () =>
    Effect.sync(() => {
      const advisory = createProviderVersionAdvisory({
        driver: "dsh" as never,
        currentVersion: "0.1.2",
        latestVersion: "0.1.5-rc.1",
        maintenanceCapabilities: makeProviderMaintenanceCapabilities({
          provider: "dsh" as never,
          packageName: "@deepseek-ai/dsh",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@deepseek-ai/dsh@latest"],
          updateLockKey: "npm-global",
        }),
      });
      expect(advisory.status).toBe("behind_latest");
      expect(advisory.canUpdate).toBe(true);
      expect(advisory.updateCommand).toContain("@deepseek-ai/dsh@latest");
    }),
  );

  it.effect("stays current when the installed version matches the published one", () =>
    Effect.sync(() => {
      const advisory = createProviderVersionAdvisory({
        driver: "dsh" as never,
        currentVersion: "0.1.5-rc.1",
        latestVersion: "0.1.5-rc.1",
      });
      expect(advisory.status).toBe("current");
    }),
  );
});

describe("DeepSeek Harness version advisory enrichment", () => {
  it.effect("marks a snapshot behind latest and keeps the update command", () =>
    Effect.gen(function* () {
      const published = yield* Ref.make<string>("0.1.5-rc.1");
      const publishedVersion = yield* Ref.get(published);
      const snapshot = {
        instanceId: ProviderInstanceId.make("dsh"),
        driver: "dsh",
        displayName: "DeepSeek Harness",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-07-17T00:00:00.000Z",
        version: "0.1.2",
        models: [],
        slashCommands: [],
        skills: [],
      } as never;

      const publishedSnapshots: Array<{
        versionAdvisory?: { status?: string; canUpdate?: boolean };
      }> = [];
      yield* enrichDshSnapshot({
        snapshot,
        maintenanceCapabilities: makeProviderMaintenanceCapabilities({
          provider: "dsh" as never,
          packageName: "@deepseek-ai/dsh",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@deepseek-ai/dsh@latest"],
          updateLockKey: "npm-global",
          latestVersion: publishedVersion,
        }),
        enableProviderUpdateChecks: true,
        publishSnapshot: (next) =>
          Effect.sync(() => {
            publishedSnapshots.push(next as never);
          }),
        httpClient: HttpClient.make(() => Effect.die("latest version is supplied")),
      });

      const advisory = publishedSnapshots.at(-1)?.versionAdvisory;
      expect(advisory?.status).toBe("behind_latest");
      expect(advisory?.canUpdate).toBe(true);
    }),
  );
});

describe("DeepSeek Harness install resolution", () => {
  // Builds the layout npm creates for a global install — an executable linked to
  // the package's own entry inside lib/node_modules — so this runs anywhere
  // instead of depending on a developer's machine.
  it.effect("resolves npm ownership from the layout npm actually creates", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prefix = yield* fs.makeTempDirectory({ prefix: "t3-dsh-npm-" });
      const binDir = path.join(prefix, "bin");
      const packageDir = path.join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.makeDirectory(packageDir, { recursive: true });
      const entry = path.join(packageDir, "dsh");
      yield* fs.writeFileString(entry, "#!/usr/bin/env node\n");
      yield* fs.chmod(entry, 0o755);
      yield* fs.symlink(entry, path.join(binDir, "dsh"));

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        makePackageManagedProviderMaintenanceResolver({
          provider: "dsh" as never,
          npmPackageName: "@deepseek-ai/dsh",
          nativeUpdate: null,
        }),
        { binaryPath: path.join(binDir, "dsh"), env: process.env },
      );

      // Ownership is read from the resolved real path, so the prefix has to be
      // compared after resolving it (macOS temp dirs are symlinked).
      const realPrefix = yield* fs.realPath(prefix);
      expect(
        npmGlobalPrefixFromCommandPath(
          path.join(realPrefix, "lib", "node_modules", "@deepseek-ai", "dsh", "dsh"),
          "@deepseek-ai/dsh",
        ),
      ).toBe(realPrefix);
      expect(capabilities.packageName).toBe("@deepseek-ai/dsh");
      expect(capabilities.update).not.toBeNull();
      yield* fs.remove(prefix, { recursive: true }).pipe(Effect.ignore);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
