import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import MaterialSettings from '$lib/components/MaterialSettings.svelte';
import { projectStore } from '$lib/stores/project.svelte';

beforeEach(() => {
  projectStore.reset();
});

/** Remove buttons are the one-per-row control we count rows by. */
function removeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]'));
}

describe('MaterialSettings sheet-size list', () => {
  it('renders one row per configured size with width, height, and Max sheets fields', () => {
    const { getAllByLabelText, getByRole } = render(MaterialSettings);

    // One configured size by default → one row's worth of each control.
    // (DimensionInput renders an mm and an in input per dimension, so two each.)
    expect(getAllByLabelText(/width/i).length).toBeGreaterThanOrEqual(1);
    expect(getAllByLabelText(/height/i).length).toBeGreaterThanOrEqual(1);
    expect(getAllByLabelText(/max sheets/i)).toHaveLength(1);
    expect(getByRole('button', { name: /add (sheet )?size/i })).toBeTruthy();
  });

  it('marks the lone remove control aria-disabled with a programmatic reason (still focusable)', () => {
    const { container } = render(MaterialSettings);

    const buttons = removeButtons(container);
    expect(buttons).toHaveLength(1);
    // Native `disabled` would remove it from the tab order and hide the reason from AT.
    expect(buttons[0].hasAttribute('disabled')).toBe(false);
    expect(buttons[0].getAttribute('aria-disabled')).toBe('true');

    // The reason is reachable programmatically via aria-describedby.
    const describedById = buttons[0].getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const reason = container.querySelector(`#${describedById}`);
    expect(reason?.textContent).toMatch(/at least one sheet size is required/i);
  });

  it('labels each remove button with its row size', () => {
    const { container } = render(MaterialSettings);

    const w = Math.round(projectStore.state.config.sheet.width);
    const h = Math.round(projectStore.state.config.sheet.height);
    const buttons = removeButtons(container);
    expect(buttons[0].getAttribute('aria-label')).toBe(`Remove ${w} × ${h}`);
  });

  it('adds a row and enables removal once more than one size exists', async () => {
    const { container, getAllByLabelText, getByRole } = render(MaterialSettings);

    await fireEvent.click(getByRole('button', { name: /add (sheet )?size/i }));

    expect(getAllByLabelText(/max sheets/i)).toHaveLength(2);
    const buttons = removeButtons(container);
    expect(buttons).toHaveLength(2);
    // Neither is aria-disabled once more than one size exists.
    expect(buttons.every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(false);
  });

  it('does not remove the last row when its aria-disabled remove button is clicked', async () => {
    const { container } = render(MaterialSettings);

    const buttons = removeButtons(container);
    await fireEvent.click(buttons[0]);

    expect(removeButtons(container)).toHaveLength(1);
    expect(projectStore.sheetSizes).toHaveLength(1);
  });

  it('groups each row with an accessible name naming the size index', async () => {
    const { getByRole, getAllByRole } = render(MaterialSettings);

    expect(getByRole('group', { name: /sheet size 1/i })).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: /add (sheet )?size/i }));

    const groups = getAllByRole('group', { name: /sheet size \d+/i });
    expect(groups).toHaveLength(2);
    expect(getByRole('group', { name: /sheet size 2/i })).toBeTruthy();
  });

  it('exposes a polite live region that announces add and remove', async () => {
    const { container, getByRole } = render(MaterialSettings);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: /add (sheet )?size/i }));
    expect(live?.textContent).toMatch(/added.*2 total/i);

    await fireEvent.click(removeButtons(container)[1]);
    expect(live?.textContent).toMatch(/removed.*1 remaining/i);
  });
});
