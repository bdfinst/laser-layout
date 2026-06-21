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
    // The backing map is the authoritative source that survives re-dedup.
    expect(projectStore.state.lockedOrientation.get(id)).toBe(true);
    expect(projectStore.state.result).toBeNull();
  });

  it('unlocks a previously locked part', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setLockOrientation(id, true);

    projectStore.setLockOrientation(id, false);

    expect(projectStore.state.parts.find((p) => p.id === id)?.lockOrientation).toBe(false);
    expect(projectStore.state.lockedOrientation.get(id)).toBe(false);
  });

  it('is a no-op for an unknown part id', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    projectStore.setLockOrientation('does-not-exist', true);
    expect(projectStore.state.parts.every((p) => p.lockOrientation !== true)).toBe(true);
  });

  it('preserves the lock across a re-dedup triggered by a tolerance change', () => {
    projectStore.setParts([rect('a', 10, 10), rect('b', 20, 5)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setLockOrientation(id, true);

    projectStore.setMatchTolerance(0.005);

    const lockedPart = projectStore.state.parts.find((p) => p.id === id);
    // Guard the id-stability assumption: the same id must still be the same shape.
    expect(lockedPart?.name).toBe('a');
    expect(lockedPart?.lockOrientation).toBe(true);
  });

  it('reset clears all lock state', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setLockOrientation(id, true);

    projectStore.reset();

    expect(projectStore.state.parts).toHaveLength(0);
    // Re-importing parts must not resurrect a stale lock.
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    expect(projectStore.state.parts.every((p) => p.lockOrientation !== true)).toBe(true);
  });
});

describe('setPriority', () => {
  it('defaults parts to required and clears any prior result when changed', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    expect(projectStore.state.parts[0].priority).toBe('required');
    projectStore.updateResult(
      { sheets: [], unplaced: [], sheetWidth: 1, sheetHeight: 1, totalPlaced: 0 },
      1,
      0,
    );

    projectStore.setPriority(id, 'optional');

    expect(projectStore.state.parts.find((p) => p.id === id)?.priority).toBe('optional');
    expect(projectStore.state.partPriority.get(id)).toBe('optional');
    expect(projectStore.state.result).toBeNull();
  });

  it('preserves priority across a re-dedup triggered by a tolerance change', () => {
    projectStore.setParts([rect('a', 10, 10), rect('b', 20, 5)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setPriority(id, 'optional');

    projectStore.setMatchTolerance(0.005);

    expect(projectStore.state.parts.find((p) => p.id === id)?.priority).toBe('optional');
  });

  it('reset clears all priority state', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    projectStore.setPriority(projectStore.state.parts[0].id, 'optional');

    projectStore.reset();
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');

    expect(projectStore.state.parts.every((p) => p.priority === 'required')).toBe(true);
  });
});

describe('setGrainConstraint', () => {
  it('sets the matching part flag and clears any prior result', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.updateResult(
      { sheets: [], unplaced: [], sheetWidth: 1, sheetHeight: 1, totalPlaced: 0 },
      1,
      0,
    );

    projectStore.setGrainConstraint(id, true);

    expect(projectStore.state.parts.find((p) => p.id === id)?.grainConstraint).toBe(true);
    expect(projectStore.state.grainConstrained.get(id)).toBe(true);
    expect(projectStore.state.result).toBeNull();
  });

  it('preserves the grain lock across a re-dedup triggered by a tolerance change', () => {
    projectStore.setParts([rect('a', 10, 10), rect('b', 20, 5)], 'f.svg');
    const id = projectStore.state.parts[0].id;
    projectStore.setGrainConstraint(id, true);

    projectStore.setMatchTolerance(0.005);

    expect(projectStore.state.parts.find((p) => p.id === id)?.grainConstraint).toBe(true);
  });

  it('reset clears all grain state', () => {
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');
    projectStore.setGrainConstraint(projectStore.state.parts[0].id, true);

    projectStore.reset();
    projectStore.setParts([rect('a', 10, 10)], 'f.svg');

    expect(projectStore.state.parts.every((p) => p.grainConstraint !== true)).toBe(true);
  });
});
