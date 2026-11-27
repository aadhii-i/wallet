import { expect, type Page } from '@playwright/test';

/** In-page navigation preserves the unlocked vault and pending signing work. */
export async function openSharedTask(page: Page, anchor: string) {
  await page.evaluate((value) => {
    window.location.hash = value;
  }, anchor);
  await expect(page).toHaveURL(new RegExp(`#${anchor}$`));
}

export async function openSharedDetails(page: Page, summary: string) {
  const control = page.locator('summary').filter({ hasText: summary }).first();
  const details = control.locator('..');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await control.click();
}
