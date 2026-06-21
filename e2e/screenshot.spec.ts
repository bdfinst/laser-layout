import { test } from '@playwright/test';
import path from 'path';

test('take screenshot of nested layout', async ({ page }) => {
  // Nesting runs to the time limit we set below, plus build/parse overhead.
  test.setTimeout(120000);

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('http://localhost:9876');
  await page.waitForTimeout(1000);

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path.resolve('test-fixtures/Hot Air Balloon.lbrn2'));

  // Wait for the file to be parsed — the "Nest Parts" button enables once
  // parts are available.
  const nestBtn = page.getByRole('button', { name: 'Nest Parts' });
  await nestBtn.waitFor({ timeout: 30000 });
  await page.locator('button.nest-btn:not([disabled])').waitFor({ timeout: 30000 });

  // Cap the nesting time so the run converges quickly for the screenshot.
  const timeLimit = page.locator('#time-budget');
  await timeLimit.fill('10');
  await timeLimit.blur();

  // Click "Nest Parts" button
  await nestBtn.scrollIntoViewIfNeeded();
  await nestBtn.click();

  // Wait for the layout to appear, then for nesting to fully finish so the
  // screenshot shows the final, densest result rather than a mid-run frame.
  // While nesting the button reads "Nesting...", and it returns to enabled
  // "Nest Parts" once the run converges or hits the time limit.
  await page.locator('.layout-svg').first().waitFor({ timeout: 30000 });
  await page.locator('button.nest-btn:not([disabled])').waitFor({ timeout: 90000 });
  await page.waitForTimeout(1000);

  // Scroll to top to capture the full layout
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  await page.screenshot({ path: 'static/screenshot.png' });
});
