import { describe, it, expect } from 'vitest';
import { serializeNestingInput } from '$lib/nesting/worker-io';
import { availableSheets } from '$lib/geometry/types';
import type { NestingInput } from '$lib/nesting/engine';

// Slice 5: the heterogeneous-sheet config fields (`sheets[]` with per-size `maxCount`,
// including an omitted/unlimited one) must survive the Web Worker wire boundary. These pin
// the serialize side of the contract so a future explicit-field serializer cannot silently
// drop the new fields — the current whole-config JSON clone carries them generically.

function baseConfig(): NestingInput['config'] {
  return {
    sheet: { width: 600, height: 350 },
    kerf: 1,
    rotationSteps: 4,
    populationSize: 5,
    generations: 5,
  };
}

describe('serializeNestingInput (heterogeneous sheets)', () => {
  it('round-trips the sheets array with per-size maxCount, including an unlimited one', () => {
    const input: NestingInput = {
      parts: [],
      quantities: new Map(),
      config: {
        ...baseConfig(),
        sheets: [
          { width: 600, height: 350, maxCount: 3 },
          { width: 500, height: 400 }, // omitted maxCount ⇒ unlimited
        ],
      },
    };

    const wire = serializeNestingInput(input);

    expect(wire.config.sheets).toEqual([
      { width: 600, height: 350, maxCount: 3 },
      { width: 500, height: 400 },
    ]);
    // The unlimited size carries no maxCount across the wire (not maxCount: undefined/null).
    expect(wire.config.sheets?.[1]).not.toHaveProperty('maxCount');
    expect(availableSheets(wire.config)).toEqual(input.config.sheets);
  });

  it('preserves a legacy single-sheet config (no sheets array) as a one-size list', () => {
    const input: NestingInput = {
      parts: [],
      quantities: new Map(),
      config: baseConfig(),
    };

    const wire = serializeNestingInput(input);

    expect(wire.config.sheets).toBeUndefined();
    expect(availableSheets(wire.config)).toEqual([{ width: 600, height: 350 }]);
  });
});
