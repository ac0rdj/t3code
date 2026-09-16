/**
 * DshAcpSupport — DeepSeek Harness (`dsh --profile acp`) over ACP.
 *
 * DSH ships a pure ACP v1 surface: it advertises no authentication methods and
 * no private `_meta`, and it selects a model through the standard `model`
 * configuration option. Its option values are JSON-encoded `[provider, model]`
 * pairs, so this module owns the translation between that wire value and the
 * `provider/model` slug T3 stores and displays.
 *
 * @module provider/acp/DshAcpSupport
 */
import { type DshSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DSH_DEFAULT_COMMAND = "dsh";

/**
 * The model DSH prefers by default. The picker shows the model id alone, so the
 * slug matches `buildDshModelsFromConfigOptions` rather than carrying a
 * provider prefix.
 */
export const DSH_DEFAULT_MODEL_SLUG = "deepseek-v4-flash";

/** Standard ACP configuration-option ids DSH advertises after `session/new`. */
export const DSH_MODEL_CONFIG_ID = "model";
export const DSH_REASONING_EFFORT_CONFIG_ID = "reasoning_effort";
/** T3 capability descriptor id carrying the reasoning-effort selection. */
export const DSH_REASONING_EFFORT_OPTION_ID = "reasoningEffort";

const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DSH_HOME_ENV = "DSH_HOME";

/**
 * `authenticate` is a no-op for DSH and rejects a method id it does not
 * advertise, so this value only satisfies the runtime and is never sent.
 */
const DSH_AUTH_METHOD_ID = "dsh.no-auth";

export type ResolvedDshModel = {
  readonly provider: string;
  readonly model: string;
};

/**
 * DSH encodes a model option value as a JSON array of two strings. Decode only
 * that exact shape so a custom model slug is never mistaken for a wire value.
 */
export function parseDshModelWireValue(
  value: string | null | undefined,
): ResolvedDshModel | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("[")) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    return undefined;
  }
  const [provider, model] = decoded as ReadonlyArray<unknown>;
  if (typeof provider !== "string" || typeof model !== "string") {
    return undefined;
  }
  const trimmedProvider = provider.trim();
  const trimmedModel = model.trim();
  if (!trimmedProvider || !trimmedModel) {
    return undefined;
  }
  return { provider: trimmedProvider, model: trimmedModel };
}

export function encodeDshModelWireValue(provider: string, model: string): string {
  return JSON.stringify([provider.trim(), model.trim()]);
}

/**
 * Resolves a T3 model slug to the `[provider, model]` pair DSH expects.
 *
 * A slug carrying an explicit `provider/` prefix wins. A bare slug keeps the
 * provider DSH is already running, so the model picker can offer the active
 * model without hardcoding `deepseek-official`. Without a preferred provider,
 * only a qualified slug resolves.
 */
export function resolveDshModelPair(input: {
  readonly model: string | null | undefined;
  readonly preferredProvider?: string | null | undefined;
}): ResolvedDshModel | undefined {
  const raw = input.model?.trim();
  if (!raw) {
    return undefined;
  }
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash).trim();
    const model = raw.slice(slash + 1).trim();
    return provider && model ? { provider, model } : undefined;
  }
  const preferredProvider = input.preferredProvider?.trim();
  return preferredProvider ? { provider: preferredProvider, model: raw } : undefined;
}

/**
 * Resolves the option value DSH accepts for a selected model.
 *
 * The picker shows one row per model, using the model id alone. A selection is
 * matched against the advertised options so a stored `provider/model` slug from
 * an earlier build still resolves, and an unadvertised model stays unselected
 * instead of producing a value DSH would reject.
 */
export function resolveDshSelectedWireValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  model: string | null | undefined,
): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }
  const slash = raw.indexOf("/");
  const requestedProvider = slash > 0 ? raw.slice(0, slash).trim() : undefined;
  const requestedModel = (slash > 0 ? raw.slice(slash + 1) : raw).trim();
  if (!requestedModel) {
    return undefined;
  }
  for (const option of flattenDshSelectOptions(
    findDshConfigOption(configOptions, DSH_MODEL_CONFIG_ID),
  )) {
    const pair = parseDshModelWireValue(option.value);
    if (!pair || pair.model !== requestedModel) {
      continue;
    }
    if (requestedProvider === undefined || requestedProvider === pair.provider) {
      // Prefer the agent's own encoding so a non-canonical value still round-trips.
      return option.value;
    }
  }
  return undefined;
}

/** Display name for a model slug, used only when DSH advertises no name. */
export function dshModelDisplayNameFromSlug(slug: string): string {
  const bare = slug.includes("/") ? (slug.slice(slug.indexOf("/") + 1) ?? slug) : slug;
  return bare
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => (part.toLowerCase() === "deepseek" ? "DeepSeek" : part))
    .join(" ");
}

export type DshSelectOption = {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
};

/** Flattens ACP grouped select options into their leaf values. */
function flattenDshSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DshSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  const toOption = (option: {
    readonly value: string;
    readonly name: string;
    readonly description?: string | null;
  }): DshSelectOption => ({
    value: option.value.trim(),
    name: option.name.trim(),
    ...(option.description?.trim() ? { description: option.description.trim() } : {}),
  });
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [toOption(entry)] : entry.options.map(toOption),
  );
}

function findDshConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.id.trim() === configId);
}

/** `currentValue` is a string for select options and a boolean for toggles. */
function selectOptionCurrentValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): string {
  if (!configOption || configOption.type !== "select") {
    return "";
  }
  return configOption.currentValue.trim();
}

export interface DshAdvertisedModel {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly isDefault: boolean;
  /** The exact option value DSH accepts for this model. */
  readonly wireValue: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * Models DSH advertises, in advertised order, with the session's current model
 * marked default. Both the qualified and bare slug are emitted; the qualified
 * one carries the advertised name and the bare one is derived from the id.
 */
export function buildDshModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DshAdvertisedModel> {
  const modelConfig = findDshConfigOption(configOptions, DSH_MODEL_CONFIG_ID);
  if (!modelConfig) {
    return [];
  }
  const currentValue = selectOptionCurrentValue(modelConfig);
  const seen = new Set<string>();
  const models: DshAdvertisedModel[] = [];
  for (const option of flattenDshSelectOptions(modelConfig)) {
    const pair = parseDshModelWireValue(option.value);
    if (!pair) {
      continue;
    }
    // One row per model: the model id is unique within a provider, so it is the
    // slug T3 stores, and the provider comes back from the advertised option
    // when the selection is written.
    const slug = pair.model;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: option.name || dshModelDisplayNameFromSlug(slug),
      ...(option.description ? { description: option.description } : {}),
      isDefault: option.value === currentValue,
      wireValue: option.value,
      provider: pair.provider,
      model: pair.model,
    });
  }
  return models;
}

export interface DshReasoningOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault: boolean;
}

/**
 * `reasoning_effort` options. DSH omits the selector for a model that declares
 * no reasoning levels, so an absent option yields an empty list.
 */
export function buildDshReasoningOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DshReasoningOption> {
  const effortConfig = findDshConfigOption(configOptions, DSH_REASONING_EFFORT_CONFIG_ID);
  if (!effortConfig) {
    return [];
  }
  const currentValue = selectOptionCurrentValue(effortConfig);
  const seen = new Set<string>();
  const options: DshReasoningOption[] = [];
  for (const entry of flattenDshSelectOptions(effortConfig)) {
    if (!entry.value || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    options.push({
      value: entry.value,
      label: entry.name || entry.value,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: entry.value === currentValue,
    });
  }
  return options;
}

/** Resolves the provider DSH is currently running, used for bare model slugs. */
export function currentDshProviderFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const modelConfig = findDshConfigOption(configOptions, DSH_MODEL_CONFIG_ID);
  return parseDshModelWireValue(selectOptionCurrentValue(modelConfig))?.provider;
}

/** Resolves the model DSH is currently running as a `provider/model` slug. */
export function currentDshModelSlugFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const modelConfig = findDshConfigOption(configOptions, DSH_MODEL_CONFIG_ID);
  const pair = parseDshModelWireValue(selectOptionCurrentValue(modelConfig));
  return pair?.model;
}

/**
 * DSH authenticates from its own credential store and falls back to
 * `DEEPSEEK_API_KEY` in the launching environment. It advertises no ACP auth
 * method, so this variable is the only credential signal T3 can read.
 */
export function dshAuthFromEnvironment(environment: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(environment?.[DEEPSEEK_API_KEY_ENV]?.trim());
}

export type DshAcpRuntimeDshSettings = Pick<DshSettings, "binaryPath" | "homePath">;

export interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly dshSettings: DshAcpRuntimeDshSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * `dsh --profile acp` serves ACP on stdio. The launcher forwards unknown
 * tokens to the profile app, so the profile selector comes first. The runtime
 * mode adds no flag because DSH never asks this client for approval.
 */
function dshAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--profile", "acp"];
}

export function buildDshAcpSpawnInput(
  dshSettings: DshAcpRuntimeDshSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = dshSettings?.homePath?.trim();
  return {
    command: dshSettings?.binaryPath?.trim() || DSH_DEFAULT_COMMAND,
    args: [...dshAcpSpawnArgs()],
    cwd,
    ...(environment || homePath
      ? {
          env: {
            ...environment,
            ...(homePath ? { [DSH_HOME_ENV]: homePath } : {}),
          },
        }
      : {}),
  };
}

export const makeDshAcpRuntime = (
  input: DshAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDshAcpSpawnInput(input.dshSettings, input.cwd, input.environment),
        authMethodId: DSH_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Applies a model and reasoning-effort selection through the standard
 * configuration options.
 *
 * A selection DSH does not advertise is dropped rather than sent, because DSH
 * rejects an unknown option value and that failure would break the turn.
 */
export function applyDshAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly reasoningEffort: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError, configId: string) => E;
}): Effect.Effect<void, E, never> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;

    const requestedWireValue = resolveDshSelectedWireValue(configOptions, input.model);
    const currentWireValue = selectOptionCurrentValue(
      findDshConfigOption(configOptions, DSH_MODEL_CONFIG_ID),
    );
    if (requestedWireValue !== undefined && requestedWireValue !== currentWireValue) {
      yield* input.runtime.setConfigOption(DSH_MODEL_CONFIG_ID, requestedWireValue).pipe(
        Effect.mapError((cause): E => input.mapError(cause, DSH_MODEL_CONFIG_ID)),
        Effect.asVoid,
      );
    }

    // A model change can refresh the option set, so re-read before validating
    // the effort against the model that is now selected.
    const effortConfig = findDshConfigOption(
      yield* input.runtime.getConfigOptions,
      DSH_REASONING_EFFORT_CONFIG_ID,
    );
    const reasoningEffort = input.reasoningEffort?.trim();
    if (reasoningEffort) {
      const advertisedEffort = flattenDshSelectOptions(effortConfig).some(
        (option) => option.value === reasoningEffort,
      );
      if (advertisedEffort && reasoningEffort !== selectOptionCurrentValue(effortConfig)) {
        yield* input.runtime.setConfigOption(DSH_REASONING_EFFORT_CONFIG_ID, reasoningEffort).pipe(
          Effect.mapError((cause): E => input.mapError(cause, DSH_REASONING_EFFORT_CONFIG_ID)),
          Effect.asVoid,
        );
      }
    }
  });
}
