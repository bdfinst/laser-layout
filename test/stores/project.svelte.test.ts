import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '$lib/stores/project.svelte';
import type { Part } from '$lib/geometry/types';

function rect(id: string, w: number, h: number): Part {
  return {
    id,
    name: id,
    polygons: [
      [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
    ],
    sourceIndex: 0,
  };
}

beforeEach(() => {
  projectStore.reset();
});

describe('setLockOrientation', () => {
  it('sets the matching part flag and clears any prior result', () => {
    projectStore.setParts([rect('a', 10, 10), rect('b', 20, 5)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.updateResult(
      { sheets: [], unplaced: [], sheetWidth: 1, sheetHeight: 1, totalPlaced: 0 },
      1,
      0,
    );

    projectStore.setLockOrientation(id, true);

    expect(projectStore.state.parts.find((p) => p.id === id)?.lockOrientation).toBe(true);
    expect(projectStore.state.result).toBeNull();
  });

  it('is a no-op for an unknown part id', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    projectStore.setLockOrientation('does-not-exist', true);
    expect(projectStore.state.parts.some((p) => p.lockOrientation)).toBe(false);
  });

  it('preserves the lock across a re-dedup triggered by a tolerance change', () => {
    projectStore.setParts([rect('a', 10, 10), rect('b', 20, 5)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setLockOrientation(id, true);

    projectStore.setMatchTolerance(0.005);

    expect(projectStore.state.parts.find((p) => p.id === id)?.lockOrientation).toBe(true);
  });

  it('reset clears all lock state', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setLockOrientation(id, true);

    projectStore.reset();

    expect(projectStore.state.parts).toHaveLength(0);
    // Re-importing parts must not resurrect a stale lock.
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    expect(projectStore.state.parts.some((p) => p.lockOrientation)).toBe(false);
  });
});
