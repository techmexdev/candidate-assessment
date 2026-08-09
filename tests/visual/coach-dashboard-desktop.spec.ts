import { expect, test } from "@playwright/test";

import { installRichCopilotRoute } from "../e2e/copilot-test-support";

test("@visual flagship coach dashboard desktop projection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByTestId("coach-day-workspace")).toBeVisible();
  await expect(page).toHaveScreenshot("coach-dashboard-desktop-1440.png", { fullPage: true });
});

test("@visual selected-member Copilot workbench desktop density", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const answer = page.locator('[data-copilot-presentation="workbench"]');
  await expect(answer).toBeVisible();
  await expect(page).toHaveScreenshot("copilot-workbench-desktop-default.png", { fullPage: true });

  const disclosures = answer.locator("details");
  for (let index = 0; index < await disclosures.count(); index += 1) {
    await disclosures.nth(index).locator(":scope > summary").click();
  }
  await expect(page).toHaveScreenshot("copilot-workbench-desktop-expanded.png", { fullPage: true });
});
