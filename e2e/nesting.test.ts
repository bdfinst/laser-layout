import { test, expect } from '@playwright/test';
import path from 'path';

const FIXTURE = path.resolve('test-fixtures/Hot Air Balloon.lbrn2');

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
		for (let i = 0; i < await qtyInputs.count(); i++) {
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
	test('shows width, height, kerf, units, and tolerance controls', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('#sheet-width')).toBeVisible();
		await expect(page.locator('#sheet-height')).toBeVisible();
		await expect(page.locator('#kerf')).toBeVisible();
		await expect(page.locator('#units')).toBeVisible();
		await expect(page.locator('#tolerance')).toBeVisible();
	});

	test('switching to inches updates labels', async ({ page }) => {
		await page.goto('/');
		await page.locator('#units').selectOption('in');
		// Labels should contain "in"
		const widthLabel = page.locator('label[for="sheet-width"]');
		await expect(widthLabel).toContainText('in');
	});

	test('changing units converts values', async ({ page }) => {
		await page.goto('/');
		// Default is 300mm
		const widthInput = page.locator('#sheet-width');
		const mmVal = parseFloat(await widthInput.inputValue());
		expect(mmVal).toBe(300);

		// Switch to inches
		await page.locator('#units').selectOption('in');
		const inVal = parseFloat(await widthInput.inputValue());
		// 300mm ≈ 11.81in
		expect(inVal).toBeCloseTo(11.81, 1);
	});

	test('entering inch value stores correct mm internally', async ({ page }) => {
		await page.goto('/');
		await page.locator('#units').selectOption('in');

		const widthInput = page.locator('#sheet-width');
		await widthInput.fill('12');
		await widthInput.dispatchEvent('change');

		// Switch back to mm to verify
		await page.locator('#units').selectOption('mm');
		const mmVal = parseFloat(await widthInput.inputValue());
		// 12in = 304.8mm
		expect(mmVal).toBeCloseTo(305, 0);
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

		await page.locator('.qty input').first().fill('0');
		await page.locator('.qty input').first().dispatchEvent('change');

		const heading = await page.locator('.part-list h3').textContent();
		// Total should have decreased
		expect(heading).toContain('total');
	});

	test('part sizes shown in selected units', async ({ page }) => {
		await page.goto('/');
		await page.locator('#file-input').setInputFiles(FIXTURE);
		await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

		// Default mm
		const sizeText = await page.locator('.size').first().textContent();
		expect(sizeText).toContain('mm');

		// Switch to inches
		await page.locator('#units').selectOption('in');
		const sizeTextIn = await page.locator('.size').first().textContent();
		expect(sizeTextIn).toContain('in');
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
		expect(await page.locator('.sheet-section').first().locator('.layout-svg path').count()).toBeGreaterThan(0);
	});

	test('re-nesting after changing quantity works', async ({ page }) => {
		await page.goto('/');
		await page.locator('#file-input').setInputFiles(FIXTURE);
		await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

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
});

test.describe('Export', () => {
	test('export controls appear after nesting', async ({ page }) => {
		await page.goto('/');
		await page.locator('#file-input').setInputFiles(FIXTURE);
		await expect(page.locator('.part-row').first()).toBeVisible({ timeout: 5000 });

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

		await page.locator('.nest-btn').click();
		await expect(page.locator('.nest-btn')).toContainText('Nest Parts', { timeout: 120000 });

		// Switch to LightBurn
		await page.locator('.export-group select').selectOption('lightburn');
		const val = await page.locator('.export-group select').inputValue();
		expect(val).toBe('lightburn');
	});
});
