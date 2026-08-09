import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installRichCopilotRoute } from "../e2e/copilot-test-support";

test("@visual flagship coach dashboard at 430px", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("coach-dashboard")).toBeVisible();
  await expect(page).toHaveScreenshot("coach-dashboard-mobile-430.png", { fullPage: true });
});

test("@a11y flagship coach dashboard has no detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("@visual selected-member Copilot workbench mobile density", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const answer = page.locator('[data-copilot-presentation="workbench"]');
  await expect(answer).toBeVisible();
  await expect(page).toHaveScreenshot("copilot-workbench-mobile-default.png", { fullPage: true });

  const disclosures = answer.locator("details");
  for (let index = 0; index < await disclosures.count(); index += 1) {
    await disclosures.nth(index).locator(":scope > summary").click();
  }
  await expect(page).toHaveScreenshot("copilot-workbench-mobile-expanded.png", { fullPage: true });
});
