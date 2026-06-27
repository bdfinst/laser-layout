import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore, fromDisplayUnits, toDisplayUnits } from '$lib/stores/project.svelte';
import { availableSheets } from '$lib/geometry/types';
import { makeRect as rect } from '../support/parts';

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

describe('sheet-size list', () => {
  it('exposes the single default size as a one-element list', () => {
    const sizes = projectStore.sheetSizes;
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toEqual({
      width: projectStore.state.config.sheet.width,
      height: projectStore.state.config.sheet.height,
    });
  });

  it('addSheetSize appends a copy-forward of the existing size and clears the result', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });
    projectStore.updateResult(
      { sheets: [], unplaced: [], sheetWidth: 1, sheetHeight: 1, totalPlaced: 0 },
      1,
      0,
    );

    projectStore.addSheetSize();

    const sizes = projectStore.sheetSizes;
    expect(sizes).toHaveLength(2);
    // New row pre-filled with the prior size's dimensions (copy-forward).
    expect(sizes[1].width).toBe(600);
    expect(sizes[1].height).toBe(350);
    // Both sizes are present in the authoritative config list the engine consumes.
    expect(availableSheets(projectStore.state.config)).toHaveLength(2);
    expect(projectStore.state.result).toBeNull();
  });

  it('addSheetSize copies the last configured size when more than one exists', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });
    projectStore.addSheetSize();
    projectStore.updateSheetSize(1, { width: 500, height: 400 });

    projectStore.addSheetSize();

    const sizes = projectStore.sheetSizes;
    expect(sizes).toHaveLength(3);
    // Copy-forward of the LAST size (500 × 400), not the first.
    expect(sizes[2]).toMatchObject({ width: 500, height: 400 });
  });

  it('updateSheetSize edits one size width without touching the others', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });
    projectStore.addSheetSize();
    projectStore.updateSheetSize(1, { width: 500, height: 400 });

    projectStore.updateSheetSize(0, { width: 650 });

    expect(projectStore.sheetSizes[0]).toMatchObject({ width: 650, height: 350 });
    expect(projectStore.sheetSizes[1]).toMatchObject({ width: 500, height: 400 });
  });

  it('removeSheetSize removes the targeted size when more than one exists', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });
    projectStore.addSheetSize();
    projectStore.updateSheetSize(1, { width: 500, height: 400 });

    projectStore.removeSheetSize(0);

    expect(projectStore.sheetSizes).toHaveLength(1);
    expect(projectStore.sheetSizes[0]).toMatchObject({ width: 500, height: 400 });
  });

  it('never removes the last remaining size', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });

    projectStore.removeSheetSize(0);

    expect(projectStore.sheetSizes).toHaveLength(1);
    expect(projectStore.sheetSizes[0]).toMatchObject({ width: 600, height: 350 });
  });

  it('setSheetMaxCount caps a size at the given count', () => {
    projectStore.setSheetMaxCount(0, 5);
    expect(projectStore.sheetSizes[0].maxCount).toBe(5);
  });

  it('setSheetMaxCount with a blank value clears the cap (unlimited)', () => {
    projectStore.setSheetMaxCount(0, 5);
    projectStore.setSheetMaxCount(0, undefined);
    expect(projectStore.sheetSizes[0].maxCount).toBeUndefined();
  });

  it('setSheetMaxCount coerces a value below 1 up to 1', () => {
    projectStore.setSheetMaxCount(0, 0);
    expect(projectStore.sheetSizes[0].maxCount).toBe(1);

    projectStore.setSheetMaxCount(0, -3);
    expect(projectStore.sheetSizes[0].maxCount).toBe(1);
  });

  it('stores the mm equivalent when a size is entered in inches', () => {
    const widthMM = fromDisplayUnits(24, 'in');

    projectStore.updateSheetSize(0, { width: widthMM });

    expect(projectStore.sheetSizes[0].width).toBeCloseTo(609.6, 5);
    expect(toDisplayUnits(projectStore.sheetSizes[0].width, 'in')).toBeCloseTo(24, 5);
  });

  it('keeps config.sheet synced to the first size for back-compat reads', () => {
    projectStore.updateSheetSize(0, { width: 600, height: 350 });
    projectStore.addSheetSize();
    projectStore.updateSheetSize(1, { width: 500, height: 400 });

    expect(projectStore.state.config.sheet).toMatchObject({ width: 600, height: 350 });
  });
});
