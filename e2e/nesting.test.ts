import { test, expect } from '@playwright/test';
import path from 'path';

const FIXTURE = path.resolve('test-fixtures/Hot Air Balloon.lbrn2');

// Density-first nesting can run up to the configurable time budget (default 60s). Cap it
// low in tests so a nest finishes well within Playwright's per-test timeout; this also
// exercises the time-limit control. The worker returns the best layout found so far.
async function setTimeLimit(page: import('@playwright/test').Page, seconds: number) {
  const input = page.locator('#time-budget');
  await input.fill(String(seconds));
  await input.dispatchEvent('change');
}

async function fillAndCommit(
  page: import('@playwright/test').Page,
  selector: string,
  value: string,
) {
  const input = page.locator(selector);
  await input.fill(value);
  await input.dispatchEvent('change');
}

test.describe('Page Load', () => {
  test('shows title and upload zone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Laser Layout');
    await expect(page.locator('.upload-zone')).toBeVisible();
  });
});

test.describe('File Upload', () => {
  test('upload LightBurn file shows deduplicated parts with auto-quantities', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    const partCount = await page.locator('.part-row').count();
    expect(partCount).toBeGreaterThan(0);

    // Each part has a thumbnail
    expect(await page.locator('.thumb svg').count()).toBe(partCount);

    // Total quantity >= unique part count (some shapes are duplicated)
    const qtyInputs = page.locator('.qty input');
    let totalQty = 0;
    for (let i = 0; i < (await qtyInputs.count()); i++) {
      totalQty += parseInt(await qtyInputs.nth(i).inputValue());
    }
    expect(totalQty).toBeGreaterThanOrEqual(partCount);
  });

  test('shows file name after upload', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.file-name')).toContainText('Hot Air Balloon');
  });
});

test.describe('Material Settings', () => {
  test('shows width, height, kerf (mm + in) and tolerance controls', async ({ page }) => {
    await page.goto('/');
    // Each dimension exposes a metric and an imperial input simultaneously.
    await expect(page.locator('#sheet-width-mm')).toBeVisible();
    await expect(page.locator('#sheet-width-in')).toBeVisible();
    await expect(page.locator('#sheet-height-mm')).toBeVisible();
    await expect(page.locator('#sheet-height-in')).toBeVisible();
    await expect(page.locator('#kerf-mm')).toBeVisible();
    await expect(page.locator('#kerf-in')).toBeVisible();
    await expect(page.locator('#tolerance')).toBeVisible();
  });

  test('mm and in inputs show the same dimension', async ({ page }) => {
    await page.goto('/');
    // Default sheet width is 508mm = 20in.
    expect(parseFloat(await page.locator('#sheet-width-mm').inputValue())).toBe(508);
    expect(parseFloat(await page.locator('#sheet-width-in').inputValue())).toBeCloseTo(20, 1);
  });

  test('editing the mm input updates the in input', async ({ page }) => {
    await page.goto('/');
    await fillAndCommit(page, '#sheet-width-mm', '254');
    // 254mm = 10in
    expect(parseFloat(await page.locator('#sheet-width-in').inputValue())).toBeCloseTo(10, 1);
  });

  test('editing the in input updates the mm input', async ({ page }) => {
    await page.goto('/');
    await fillAndCommit(page, '#sheet-width-in', '12');
    // 12in = 304.8mm
    expect(parseFloat(await page.locator('#sheet-width-mm').inputValue())).toBeCloseTo(305, 0);
  });

  test('tolerance slider adjusts shape matching', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    const initialCount = await page.locator('.part-row').count();

    // Set tolerance to minimum (0.1%) — may produce more unique parts
    await page.locator('#tolerance').fill('0.1');
    await page.locator('#tolerance').dispatchEvent('input');

    // Part count should be >= initial (tighter tolerance = more unique parts)
    const newCount = await page.locator('.part-row').count();
    expect(newCount).toBeGreaterThanOrEqual(initialCount);
  });
});

test.describe('Part List', () => {
  test('quantity change updates total', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    const heading = page.locator('.part-list h3');
    const initialText = await heading.textContent();

    await page.locator('.qty input').first().fill('5');
    await page.locator('.qty input').first().dispatchEvent('change');

    await expect(heading).not.toHaveText(initialText!);
  });

  test('setting quantity to 0 reduces total', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    // Parse initial total from heading like "Parts (15 total)"
    const initialHeading = await page.locator('.part-list h3').textContent();
    const initialTotal = parseInt(initialHeading!.match(/\((\d+)/)?.[1] ?? '0');

    await page.locator('.qty input').first().fill('0');
    await page.locator('.qty input').first().dispatchEvent('change');

    const newHeading = await page.locator('.part-list h3').textContent();
    const newTotal = parseInt(newHeading!.match(/\((\d+)/)?.[1] ?? '0');
    expect(newTotal).toBeLessThan(initialTotal);
  });

  test('part sizes shown in both mm and in', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    // Each part row shows both metric and imperial dimensions at once.
    const row = page.locator('.part-row').first();
    await expect(row.locator('.size', { hasText: 'mm' })).toBeVisible();
    await expect(row.locator('.size', { hasText: 'in' })).toBeVisible();
  });

  test('lock orientation toggle round-trips, is labelled, and nest still completes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 15000 });

    const lock = page.locator('.lock-orientation input').first();
    await expect(lock).not.toBeChecked();
    await expect(lock).toHaveAttribute('id', /^lock-/);
    // The label/for association resolves to a real accessible name (screen-reader contract).
    await expect(lock).toHaveAccessibleName(/Lock orientation/);

    await lock.check();
    await expect(lock).toBeChecked();
    // True round-trip: unchecking returns it to the default state.
    await lock.uncheck();
    await expect(lock).not.toBeChecked();
    await lock.check();
    await expect(lock).toBeChecked();

    await setTimeLimit(page, 10);
    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });
    await expect(page.locator('.overall-stats')).toBeVisible();
    // The locked-part nest still produces placements.
    await expect(page.locator('.overall-stats')).toContainText(/Total placed:\s*[1-9]/);
  });

  test('priority and grain controls round-trip and a nest still completes', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 15000 });

    // Quantity priority defaults to "required" and toggles to "optional".
    const priority = page.locator('.priority select').first();
    await expect(priority).toHaveValue('required');
    await priority.selectOption('optional');
    await expect(priority).toHaveValue('optional');
    await priority.selectOption('required');
    await expect(priority).toHaveValue('required');

    // Grain lock defaults off, is labelled, and round-trips.
    const grain = page.locator('.grain input').first();
    await expect(grain).not.toBeChecked();
    await expect(grain).toHaveAttribute('id', /^grain-/);
    await expect(grain).toHaveAccessibleName(/Grain/);
    await grain.check();
    await expect(grain).toBeChecked();
    await grain.uncheck();
    await expect(grain).not.toBeChecked();

    // Mark the part optional + grain-locked, then confirm a nest still completes.
    await priority.selectOption('optional');
    await grain.check();
    await setTimeLimit(page, 10);
    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });
    await expect(page.locator('.overall-stats')).toBeVisible();
  });
});

test.describe('Nesting', () => {
  test('nest button disabled without file', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.nest-btn')).toBeDisabled();
  });

  test('nest completes and shows multi-sheet layout', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });
    await setTimeLimit(page, 10);

    const nestBtn = page.locator('.nest-btn');
    await expect(nestBtn).toBeEnabled();
    await nestBtn.click();

    // Shows progress with sheet info
    await expect(nestBtn).toContainText('Nesting', { timeout: 2000 });

    // Completes
    await expect(nestBtn).toContainText('Nest Parts', { timeout: 120000 });

    // Overall stats visible
    await expect(page.locator('.overall-stats')).toBeVisible();
    const stats = await page.locator('.overall-stats').textContent();
    expect(stats).toContain('Sheets:');
    expect(stats).toContain('Total placed:');

    // At least one sheet section with SVG paths
    expect(await page.locator('.sheet-section').count()).toBeGreaterThan(0);
    expect(
      await page.locator('.sheet-section').first().locator('.layout-svg path').count(),
    ).toBeGreaterThan(0);
  });

  test('re-nesting after changing quantity works', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });
    await setTimeLimit(page, 10);

    // First nest
    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });
    const firstStats = await page.locator('.overall-stats').textContent();

    // Change a quantity
    await page.locator('.qty input').first().fill('5');
    await page.locator('.qty input').first().dispatchEvent('change');

    // Nest again
    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });

    // Stats should differ
    const secondStats = await page.locator('.overall-stats').textContent();
    expect(secondStats).not.toBe(firstStats);
  });

  test('exposes generations, time limit, and density controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#generations')).toBeVisible();
    await expect(page.locator('#time-budget')).toBeVisible();
    await expect(page.locator('#max-density')).toBeVisible();
    // Density-first is the default.
    await expect(page.locator('#max-density')).toBeChecked();
  });

  test('common-line cutting toggle round-trips and a nest still completes (#43)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    // Defaults off, is labelled, and round-trips.
    const clc = page.locator('#common-line');
    await expect(clc).toBeVisible();
    await expect(clc).not.toBeChecked();
    await expect(clc).toHaveAccessibleName(/Common-line/i);
    await clc.check();
    await expect(clc).toBeChecked();

    // A nest completes with common-line cutting enabled, and export is offered.
    await setTimeLimit(page, 10);
    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });
    await expect(page.locator('.export-btn')).toBeVisible();
  });

  test('stop halts nesting and keeps the best layout so far', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

    await page.locator('.nest-btn').click();
    // Wait until the first progress arrives (a layout exists), then stop mid-run so there
    // is a best-so-far layout to keep.
    await expect(page.locator('.overall-stats')).toBeVisible({ timeout: 10000 });
    const stopBtn = page.locator('.stop-btn');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Returns to idle and keeps the best layout found so far.
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 5000 });
    await expect(stopBtn).toBeHidden();
    await expect(page.locator('.overall-stats')).toBeVisible();
  });
});

test.describe('Export', () => {
  test('export controls appear after nesting', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });
    await setTimeLimit(page, 10);

    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });

    await expect(page.locator('.export-group')).toBeVisible();
    await expect(page.locator('.export-btn')).toBeVisible();
    await expect(page.locator('.export-group select option')).toHaveCount(2);
  });

  test('export format can be switched', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });
    await setTimeLimit(page, 10);

    await page.locator('.nest-btn').click();
    await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });

    // Switch to LightBurn
    await page.locator('.export-group select').selectOption('lightburn');
    const val = await page.locator('.export-group select').inputValue();
    expect(val).toBe('lightburn');
  });
});
