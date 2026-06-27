import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * AC7 / Slice 6 Step 6.2: the layout preview must render each sheet at its OWN dimensions and
 * label each sheet header with its size, not the result-level default.
 *
 * This drives a genuinely mixed-size result through the UI: configure two material sheet sizes,
 * nest a parts set that forces the engine to open sheets of both sizes, then assert the preview
 * draws two regions with different aspect ratios and headers showing the two distinct sizes.
 *
 * The size-list controls are the Slice 7 material-settings UI (`.sheet-size-row` rows with an
 * "Add size" button). Selectors are row-scoped because DimensionInput renders a paired mm + in
 * input per dimension; the mm field is the first match within a row.
 */
test('preview renders and labels each sheet at its own size', async ({ page }) => {
  test.setTimeout(120000);

  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto('/');
  await page.waitForTimeout(1000);

  // --- Configure two material sheet sizes (Slice 7 UI) ---------------------------------------
  // Each size is an editable `.sheet-size-row`. DimensionInput renders a paired mm + in input
  // per dimension, so selectors are row-scoped and take the first (mm) field within the row.
  const rows = page.locator('.sheet-size-row');
  const widthMm = (row: ReturnType<typeof rows.nth>) => row.getByLabel(/width/i).first();
  const heightMm = (row: ReturnType<typeof rows.nth>) => row.getByLabel(/height/i).first();

  // First size: a wide 600 × 350 sheet (already the default first row).
  const firstRow = rows.nth(0);
  await widthMm(firstRow).fill('600');
  await widthMm(firstRow).blur();
  await heightMm(firstRow).fill('350');
  await heightMm(firstRow).blur();

  // Add a second, differently-shaped size: a tall 500 × 400 sheet.
  await page.getByRole('button', { name: /add (sheet )?size/i }).click();
  await expect(rows).toHaveCount(2);
  const secondRow = rows.nth(1);
  await widthMm(secondRow).fill('500');
  await widthMm(secondRow).blur();
  await heightMm(secondRow).fill('400');
  await heightMm(secondRow).blur();

  // Use the fast (bottom-left) placement path, not the density/NFP search. This feature under
  // test is the per-sheet preview rendering, which is independent of the placement strategy;
  // the fast path packs this heavy fixture into a finished multi-sheet result well within budget,
  // whereas the slow density search can exhaust the time budget mid-pack on a single sheet.
  const density = page.locator('#max-density');
  if (await density.isChecked()) await density.uncheck();

  // --- Upload parts that force mixing across both sizes --------------------------------------
  // The fixture's part areas exceed one sheet, so the engine opens several and (per the
  // least-committed-area objective) mixes both configured sizes.
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path.resolve('test-fixtures/lego-shelves.lbrn2'));

  const nestBtn = page.getByRole('button', { name: 'Nest Parts' });
  await nestBtn.waitFor({ timeout: 30000 });
  await page.locator('button.nest-btn:not([disabled])').waitFor({ timeout: 30000 });

  const timeLimit = page.locator('#time-budget');
  await timeLimit.fill('45');
  await timeLimit.blur();

  await nestBtn.scrollIntoViewIfNeeded();
  await nestBtn.click();

  await page.locator('.layout-svg').first().waitFor({ timeout: 30000 });
  await page.locator('button.nest-btn:not([disabled])').waitFor({ timeout: 90000 });
  await page.waitForTimeout(500);

  // --- Assert per-sheet dimensions and size labels ------------------------------------------
  // The mixed result opens at least two sheets; assert robustly across however many it opens.
  const sections = page.locator('.sheet-section');
  const count = await sections.count();
  expect(count).toBeGreaterThanOrEqual(2);

  const aspect = (viewBox: string): number => {
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    return w / h;
  };

  const viewBoxes: string[] = [];
  const headerText: string[] = [];
  for (let i = 0; i < count; i++) {
    const vb = await sections.nth(i).locator('svg.layout-svg').getAttribute('viewBox');
    expect(vb).not.toBeNull();
    viewBoxes.push(vb!);
    const header = await sections.nth(i).locator('.sheet-header').innerText();
    expect(header).toContain('Size:');
    headerText.push(header);
  }

  // Each sheet's SVG viewBox reflects its own dimensions: at least two rendered sheets have
  // distinct aspect ratios (600×350 ≈ 1.71 vs 500×400 = 1.25), proving per-sheet sizing.
  const aspects = viewBoxes.map(aspect);
  const distinct = aspects.some((a) => aspects.some((b) => Math.abs(a - b) > 0.05));
  expect(distinct).toBe(true);

  // Together the headers name both configured sizes in the active display unit.
  const headers = headerText.join('\n');
  expect(headers).toContain('600');
  expect(headers).toContain('350');
  expect(headers).toContain('500');
  expect(headers).toContain('400');
});
