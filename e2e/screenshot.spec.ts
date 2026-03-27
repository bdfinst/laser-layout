import { test } from '@playwright/test';
import path from 'path';

test('take screenshot of nested layout', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 800 });
	await page.goto('http://localhost:9876');
	await page.waitForTimeout(1000);

	const fileInput = page.locator('input[type="file"]');
	await fileInput.setInputFiles(path.resolve('test-fixtures/Hot Air Balloon.lbrn2'));
	await page.waitForTimeout(1000);

	// Click "Nest Parts" button
	const nestBtn = page.getByRole('button', { name: 'Nest Parts' });
	await nestBtn.scrollIntoViewIfNeeded();
	await nestBtn.click();

	// Wait for nesting to finish — the button text changes or an SVG appears
	await page.locator('.layout-svg').first().waitFor({ timeout: 30000 });
	await page.waitForTimeout(2000);

	// Scroll to top to capture the full layout
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(500);

	await page.screenshot({ path: 'static/screenshot.png' });
});
