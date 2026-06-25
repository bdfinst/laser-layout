import type { NestingInput } from './engine';

/**
 * Wire-form contract between the main thread and the nesting workers. `serializeNestingInput`
 * (main thread) and `rehydrateQuantities` (worker) are inverses around `postMessage`'s structured
 * clone. Kept in this side-effect-free module so the main thread can import the serializer without
 * pulling in `nesting-worker.ts`'s top-level `self.onmessage` wiring.
 */

/** The structured-clone-safe shape posted to a worker: `$state` proxies stripped and the
 * quantities `Map` flattened to a plain record (rehydrated by `rehydrateQuantities`). */
export interface SerializedNestingInput {
  parts: NestingInput['parts'];
  quantities: Record<string, number>;
  config: NestingInput['config'];
}

/**
 * Produce the worker wire form: deep-clone via JSON to strip Svelte `$state` proxies (not
 * structured-cloneable) and flatten the quantities `Map` to a plain record.
 */
export function serializeNestingInput(input: NestingInput): SerializedNestingInput {
  return JSON.parse(
    JSON.stringify({
      parts: input.parts,
      quantities: Object.fromEntries(input.quantities),
      config: input.config,
    }),
  );
}

/**
 * Rehydrate the part-quantities map from its structured-clone-serialized form. `postMessage`
 * may deliver the `Map` as a `Map`, an array of `[id, count]` pairs, or a plain object depending
 * on the browser, so accept all three wire forms (not `NestingInput['quantities']`, which is just
 * `Map`). String values are coerced via `Number(...)` exactly as before — a non-numeric string
 * therefore yields `NaN`. A `Map` input is returned as a copy, never the original reference.
 */
export function rehydrateQuantities(
  raw: Map<string, number> | readonly [string, number][] | Record<string, number | string>,
): Map<string, number> {
  if (raw instanceof Map) return new Map(raw);
  if (Array.isArray(raw)) return new Map(raw);
  return new Map(
    Object.entries(raw as Record<string, number | string>).map(([k, v]) => [k, Number(v)]),
  );
}
