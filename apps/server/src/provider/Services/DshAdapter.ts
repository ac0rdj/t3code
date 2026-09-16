/**
 * DshAdapter — shape type for the DeepSeek Harness provider adapter.
 *
 * The driver model ({@link ../Drivers/DshDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for that bundle.
 *
 * @module DshAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DshAdapterShape — per-instance DeepSeek Harness adapter contract.
 */
export interface DshAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
