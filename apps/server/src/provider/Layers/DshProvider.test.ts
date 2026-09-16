import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { encodeDshModelWireValue } from "../acp/DshAcpSupport.ts";
import {
  buildDshModelCapabilities,
  buildDshModelsFromSessionConfigOptions,
  buildInitialDshProviderSnapshot,
} from "./DshProvider.ts";

const FLASH = encodeDshModelWireValue("deepseek-official", "deepseek-v4-flash");

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
          { value: FLASH, name: "DeepSeek-V4-Flash" },
          {
            value: encodeDshModelWireValue("deepseek-official", "deepseek-v4-pro"),
            name: "DeepSeek-V4-Pro",
          },
        ],
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
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("buildDshModelCapabilities", () => {
  it("exposes the advertised reasoning levels on every model", () => {
    const capabilities = buildDshModelCapabilities(dshConfigOptions);
    expect(capabilities).toMatchObject({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ],
        },
      ],
    });
  });

  it("reports no options when DSH advertises no reasoning levels", () => {
    expect(buildDshModelCapabilities(undefined)).toEqual({ optionDescriptors: [] });
    expect(buildDshModelCapabilities([dshConfigOptions[0]!])).toEqual({ optionDescriptors: [] });
  });
});

describe("buildDshModelsFromSessionConfigOptions", () => {
  it("attaches the same capabilities to every advertised model", () => {
    const models = buildDshModelsFromSessionConfigOptions(dshConfigOptions);
    expect(models.map((model) => [model.slug, model.isDefault === true])).toEqual([
      ["deepseek-v4-flash", true],
      ["deepseek-v4-pro", false],
    ]);
    expect(models[0]?.name).toBe("DeepSeek-V4-Flash");
    for (const model of models) {
      expect(model.isCustom).toBe(false);
      expect(model.capabilities?.optionDescriptors).toHaveLength(1);
    }
  });

  it("returns an empty catalog rather than partial rows", () => {
    expect(buildDshModelsFromSessionConfigOptions(undefined)).toEqual([]);
  });
});

describe("buildInitialDshProviderSnapshot", () => {
  it.effect("reports a disabled provider without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDshProviderSnapshot({
        enabled: false,
        binaryPath: "dsh",
        homePath: "",
      });

      expect(snapshot.displayName).toBe("DeepSeek Harness");
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.badgeLabel).toBe("Runs without approvals");
      expect(snapshot.supportsConversationRollback).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-v4-flash"]);
      // Slash commands come from the status check, not this pre-probe snapshot.
      expect(snapshot.slashCommands).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
