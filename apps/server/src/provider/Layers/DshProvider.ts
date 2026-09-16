/**
 * DshProvider — DeepSeek Harness provider snapshot, catalog, and health probe.
 *
 * DSH advertises its model catalog and reasoning levels in the `session/new`
 * response of its ACP profile, so discovery opens one short-lived ACP session
 * and reads the standard configuration options. Nothing here sends a prompt,
 * starts a turn, or writes to the workspace.
 *
 * @module provider/Layers/DshProvider
 */
import type {
  DshSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildDshModelsFromConfigOptions,
  buildDshReasoningOptions,
  DSH_DEFAULT_MODEL_SLUG,
  DSH_REASONING_EFFORT_OPTION_ID,
  dshAuthFromEnvironment,
  makeDshAcpRuntime,
} from "../acp/DshAcpSupport.ts";

const DSH_PRESENTATION = {
  displayName: "DeepSeek Harness",
  supportsConversationRollback: false,
  // DSH executes tools without asking this client for approval, so there is no
  // meaningful interaction mode to toggle. The badge carries the same warning.
  showInteractionModeToggle: false,
  badgeLabel: "Runs without approvals",
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Opening one ACP session boots the harness; it is local work, but not instant.
const DSH_ACP_DISCOVERY_TIMEOUT_MS = 20_000;

const DSH_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DSH_DEFAULT_MODEL_SLUG,
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const DSH_MISSING_BINARY_MESSAGE =
  "DeepSeek Harness CLI (`dsh`) is not installed or not on PATH. Install it with `npm install -g @deepseek-ai/dsh`, then set the binary path if it lives outside PATH.";

/**
 * Reasoning levels are advertised per session rather than per model, so every
 * model in one snapshot carries the same descriptor.
 */
export function buildDshModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const reasoning = buildDshReasoningOptions(configOptions);
  if (reasoning.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: DSH_REASONING_EFFORT_OPTION_ID,
        label: "Reasoning",
        options: reasoning.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          ...(option.isDefault ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

/** Models DSH advertised, with capabilities attached from the same snapshot. */
export function buildDshModelsFromSessionConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const capabilities = buildDshModelCapabilities(configOptions);
  return buildDshModelsFromConfigOptions(configOptions).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities,
  }));
}

/**
 * DSH accepts a model only when its ACP option advertises it, so the catalog is
 * the advertised list and never a user-supplied one. The built-in list is the
 * fallback used before discovery succeeds.
 */
function dshModels(
  builtInModels: ReadonlyArray<ServerProviderModel> = DSH_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, [], EMPTY_CAPABILITIES);
}

export function buildInitialDshProviderSnapshot(
  dshSettings: DshSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = dshModels();

    if (!dshSettings.enabled) {
      return buildServerProvider({
        presentation: DSH_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DeepSeek Harness is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DeepSeek Harness CLI availability...",
      },
    });
  });
}

const runDshCliCommand = (
  dshSettings: DshSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = dshSettings.binaryPath?.trim() || "dsh";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Reads the live model catalog and reasoning levels by opening one ACP session
 * and closing it. This never prompts, so it cannot spend tokens on a turn.
 */
const discoverDshModelsViaAcp = (
  dshSettings: DshSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDshAcpRuntime({
      dshSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.start();
    return yield* acp.getConfigOptions;
  }).pipe(Effect.scoped);

function describeDshAuth(environment: NodeJS.ProcessEnv): ServerProviderAuth {
  return dshAuthFromEnvironment(environment)
    ? { status: "authenticated", type: "api_key", label: "DEEPSEEK_API_KEY" }
    : { status: "unknown" };
}

export const checkDshProviderStatus = Effect.fn("checkDshProviderStatus")(function* (
  dshSettings: DshSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = dshModels();

  if (!dshSettings.enabled) {
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDshCliCommand(dshSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("DeepSeek Harness CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? DSH_MISSING_BINARY_MESSAGE
          : "Failed to execute the DeepSeek Harness CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is installed but timed out while running `dsh --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("DeepSeek Harness version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is installed but failed to run.",
      },
    });
  }

  const auth = describeDshAuth(environment);
  const discovery = yield* discoverDshModelsViaAcp(dshSettings, environment, cwd).pipe(
    Effect.timeoutOption(DSH_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  const discoveredOptions = Result.isSuccess(discovery) ? discovery.success : Option.none();
  // `timeoutOption` collapses a timeout into `None`, so a `None` success is a
  // failed probe even though the effect itself succeeded.
  const discoveryFailed = Result.isFailure(discovery) || Option.isNone(discoveredOptions);
  const configOptions = Option.getOrElse(
    discoveredOptions,
    () => [] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  );
  if (discoveryFailed) {
    yield* Effect.logWarning("DeepSeek Harness ACP catalog probe failed or timed out.", {
      errorTag: Result.isFailure(discovery)
        ? causeErrorTag(Cause.fail(discovery.failure))
        : "Timeout",
    });
  }

  const discoveredModels = buildDshModelsFromSessionConfigOptions(configOptions);
  const models = discoveredModels.length > 0 ? dshModels(discoveredModels) : fallbackModels;

  return buildServerProvider({
    presentation: DSH_PRESENTATION,
    enabled: dshSettings.enabled,
    checkedAt,
    models,
    // DSH mounts `dsh-command-compact` and runs `/compact` when the prompt is the
    // command, but it never advertises `available_commands`, so the command is
    // not discoverable from the protocol. T3 lists it explicitly.
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed catalog probe degrades the model picker; it does not make chats fail.
      status: discoveryFailed ? "warning" : "ready",
      auth,
      ...(discoveryFailed
        ? { message: "Model discovery failed, so the model picker may be incomplete." }
        : {}),
    },
  });
});

export const enrichDshSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("DeepSeek Harness version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
