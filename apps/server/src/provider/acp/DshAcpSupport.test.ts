import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import {
  applyDshAcpModelSelection,
  buildDshAcpSpawnInput,
  buildDshModelsFromConfigOptions,
  buildDshReasoningOptions,
  currentDshModelSlugFromConfigOptions,
  currentDshProviderFromConfigOptions,
  dshAuthFromEnvironment,
  dshModelDisplayNameFromSlug,
  encodeDshModelWireValue,
  parseDshModelWireValue,
  resolveDshSelectedWireValue,
} from "./DshAcpSupport.ts";

const FLASH = encodeDshModelWireValue("deepseek-official", "deepseek-v4-flash");
const PRO = encodeDshModelWireValue("deepseek-official", "deepseek-v4-pro");
const FLASH_SLUG = "deepseek-v4-flash";
const PRO_SLUG = "deepseek-v4-pro";

/** Mirrors the configuration options `dsh --profile acp` returns from `session/new`. */
const dshConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: FLASH,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          {
            value: PRO,
            name: "DeepSeek-V4-Pro",
            description: "Stronger agentic coding.",
          },
          { value: FLASH, name: "DeepSeek-V4-Flash" },
        ],
      },
      {
        // A second route serving the same model id. The picker must still show
        // one row for it, so this is what makes the dedupe observable.
        group: "gateway",
        name: "Gateway",
        options: [{ value: '["gateway","deepseek-v4-pro"]', name: "Pro via gateway" }],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High", description: "The default balance." },
      { value: "max", name: "Max" },
    ],
  },
];

describe("parseDshModelWireValue", () => {
  it("decodes the JSON pair DSH sends", () => {
    expect(parseDshModelWireValue(FLASH)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("rejects a value that is not a wire pair", () => {
    expect(parseDshModelWireValue(undefined)).toBeUndefined();
    expect(parseDshModelWireValue("")).toBeUndefined();
    expect(parseDshModelWireValue("deepseek-v4-flash")).toBeUndefined();
    expect(parseDshModelWireValue("[not json")).toBeUndefined();
    expect(parseDshModelWireValue('["only-one"]')).toBeUndefined();
    expect(parseDshModelWireValue('["a","b","c"]')).toBeUndefined();
    expect(parseDshModelWireValue('["","model"]')).toBeUndefined();
    expect(parseDshModelWireValue('["provider","  "]')).toBeUndefined();
    expect(parseDshModelWireValue("[1,2]")).toBeUndefined();
  });

  it("round-trips through the encoder", () => {
    expect(parseDshModelWireValue(encodeDshModelWireValue("p", "m"))).toEqual({
      provider: "p",
      model: "m",
    });
  });
});

describe("resolveDshSelectedWireValue", () => {
  it("resolves a model id to the option value DSH advertised", () => {
    expect(resolveDshSelectedWireValue(dshConfigOptions, PRO_SLUG)).toBe(PRO);
    expect(resolveDshSelectedWireValue(dshConfigOptions, FLASH_SLUG)).toBe(FLASH);
  });

  it("still resolves a provider-qualified slug from an earlier build", () => {
    expect(resolveDshSelectedWireValue(dshConfigOptions, "deepseek-official/deepseek-v4-pro")).toBe(
      PRO,
    );
  });

  it("does not resolve a model DSH does not advertise", () => {
    expect(resolveDshSelectedWireValue(dshConfigOptions, "deepseek-v4-untold")).toBeUndefined();
    expect(
      resolveDshSelectedWireValue(dshConfigOptions, "other-provider/deepseek-v4-pro"),
    ).toBeUndefined();
    expect(resolveDshSelectedWireValue(dshConfigOptions, "")).toBeUndefined();
    expect(resolveDshSelectedWireValue(dshConfigOptions, undefined)).toBeUndefined();
  });
});

describe("dsh model display names", () => {
  it("derives a readable name only from the model half", () => {
    expect(dshModelDisplayNameFromSlug("deepseek-official/deepseek-v4-pro")).toBe(
      "DeepSeek v4 pro",
    );
    expect(dshModelDisplayNameFromSlug("deepseek-v4-pro")).toBe("DeepSeek v4 pro");
  });
});

describe("buildDshModelsFromConfigOptions", () => {
  it("lists one row per model using the model id, newest advertised order kept", () => {
    const models = buildDshModelsFromConfigOptions(dshConfigOptions);
    expect(models.map((model) => model.slug)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(models.map((model) => model.name)).toEqual(["DeepSeek-V4-Pro", "DeepSeek-V4-Flash"]);
    expect(models.find((model) => model.slug === FLASH_SLUG)?.isDefault).toBe(true);
    expect(models.find((model) => model.slug === PRO_SLUG)?.isDefault).toBe(false);
    // The provider and raw option value travel with the model so a selection
    // can be written without reading the option list again.
    expect(models.find((model) => model.slug === PRO_SLUG)).toMatchObject({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      wireValue: PRO,
    });
  });

  it("never emits one model twice when two routes serve the same model", () => {
    // Removing the dedupe guard makes this list longer rather than merely
    // differently ordered, so the assertion cannot pass vacuously.
    const models = buildDshModelsFromConfigOptions(dshConfigOptions);
    expect(models.map((model) => model.slug)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(new Set(models.map((model) => model.slug)).size).toBe(models.length);
  });

  it("returns nothing without a model option", () => {
    expect(buildDshModelsFromConfigOptions(undefined)).toEqual([]);
    expect(buildDshModelsFromConfigOptions([])).toEqual([]);
  });

  it("skips an option value that is not a wire pair", () => {
    const models = buildDshModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "not-a-pair",
        options: [{ value: "not-a-pair", name: "Nonsense" }],
      },
    ]);
    expect(models).toEqual([]);
  });
});

describe("buildDshReasoningOptions", () => {
  it("reads the advertised levels and marks the current one", () => {
    const options = buildDshReasoningOptions(dshConfigOptions);
    expect(options.map((option) => option.value)).toEqual(["off", "low", "high", "max"]);
    expect(options.find((option) => option.value === "high")).toMatchObject({
      isDefault: true,
      description: "The default balance.",
    });
  });

  it("returns nothing when DSH omits the selector", () => {
    expect(buildDshReasoningOptions(undefined)).toEqual([]);
    expect(buildDshReasoningOptions([dshConfigOptions[0]!])).toEqual([]);
  });
});

describe("current DSH session state", () => {
  it("reports the running provider and model slug", () => {
    expect(currentDshProviderFromConfigOptions(dshConfigOptions)).toBe("deepseek-official");
    expect(currentDshModelSlugFromConfigOptions(dshConfigOptions)).toBe(FLASH_SLUG);
  });

  it("reports nothing when the model option is absent or malformed", () => {
    expect(currentDshProviderFromConfigOptions(undefined)).toBeUndefined();
    expect(currentDshModelSlugFromConfigOptions(undefined)).toBeUndefined();
    expect(
      currentDshModelSlugFromConfigOptions([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "opaque",
          options: [{ value: "opaque", name: "Opaque" }],
        },
      ]),
    ).toBeUndefined();
  });
});

describe("dshAuthFromEnvironment", () => {
  it("reports a key only when the variable carries a value", () => {
    expect(dshAuthFromEnvironment({ DEEPSEEK_API_KEY: "sk-test" })).toBe(true);
    expect(dshAuthFromEnvironment({ DEEPSEEK_API_KEY: "   " })).toBe(false);
    expect(dshAuthFromEnvironment({})).toBe(false);
    expect(dshAuthFromEnvironment(undefined)).toBe(false);
  });
});

describe("buildDshAcpSpawnInput", () => {
  it("defaults to the dsh binary and the acp profile", () => {
    const spawn = buildDshAcpSpawnInput(null, "/tmp/work");
    expect(spawn.command).toBe("dsh");
    expect(spawn.args).toEqual(["--profile", "acp"]);
    expect(spawn.cwd).toBe("/tmp/work");
    expect(spawn.env).toBeUndefined();
  });

  it("honours a configured binary and home", () => {
    const spawn = buildDshAcpSpawnInput(
      { binaryPath: "/opt/dsh/bin/dsh", homePath: "/tmp/dsh-home" },
      "/tmp/work",
      { PATH: "/usr/bin" },
    );
    expect(spawn.command).toBe("/opt/dsh/bin/dsh");
    expect(spawn.env).toEqual({ PATH: "/usr/bin", DSH_HOME: "/tmp/dsh-home" });
  });

  it("leaves DSH_HOME to the machine default when unset or blank", () => {
    expect(
      buildDshAcpSpawnInput({ binaryPath: "dsh", homePath: "  " }, "/tmp/work")?.env,
    ).toBeUndefined();
  });
});

/** Runs a selection against the DSH configuration options and reports the writes. */
const applySelection = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  selection: { model?: string | null; reasoningEffort?: string | null },
) => {
  const writes: Array<{ configId: string; value: string | boolean }> = [];
  const runtime: Parameters<typeof applyDshAcpModelSelection<AcpRequestError>>[0]["runtime"] = {
    getConfigOptions: Effect.succeed(configOptions),
    setConfigOption: (configId, value) =>
      Effect.sync(() => {
        writes.push({ configId, value });
        return { configOptions };
      }),
  };
  return applyDshAcpModelSelection({
    runtime,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    mapError: (cause, configId) =>
      new AcpRequestError({
        code: -32603,
        errorMessage: `${configId}: ${cause.message}`,
      }),
  }).pipe(Effect.as(writes));
};

describe("applyDshAcpModelSelection", () => {
  it.effect("writes the encoded pair when the model changes", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { model: PRO_SLUG })).toEqual([
        { configId: "model", value: PRO },
      ]);
    }),
  );

  it.effect("does not rewrite the model DSH already runs", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { model: FLASH_SLUG })).toEqual([]);
    }),
  );

  it.effect("drops a model DSH does not advertise", () =>
    Effect.gen(function* () {
      expect(
        yield* applySelection(dshConfigOptions, {
          model: "deepseek-official/deepseek-v4-untold",
        }),
      ).toEqual([]);
    }),
  );

  it.effect("resolves a bare slug against the running provider", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { model: "deepseek-v4-pro" })).toEqual([
        { configId: "model", value: PRO },
      ]);
    }),
  );

  it.effect("writes reasoning effort through its own config id", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { reasoningEffort: "max" })).toEqual([
        { configId: "reasoning_effort", value: "max" },
      ]);
    }),
  );

  it.effect("does not rewrite the effort DSH already runs", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { reasoningEffort: "high" })).toEqual([]);
    }),
  );

  it.effect("drops an effort DSH does not advertise", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, { reasoningEffort: "turbo" })).toEqual([]);
    }),
  );

  it.effect("applies model and effort in that order", () =>
    Effect.gen(function* () {
      expect(
        yield* applySelection(dshConfigOptions, { model: PRO_SLUG, reasoningEffort: "low" }),
      ).toEqual([
        { configId: "model", value: PRO },
        { configId: "reasoning_effort", value: "low" },
      ]);
    }),
  );

  it.effect("writes nothing when no selection is requested", () =>
    Effect.gen(function* () {
      expect(yield* applySelection(dshConfigOptions, {})).toEqual([]);
    }),
  );
});
