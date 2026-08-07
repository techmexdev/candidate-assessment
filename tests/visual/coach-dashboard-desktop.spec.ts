import { expect, test } from "@playwright/test";

test("@visual flagship coach dashboard desktop projection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByTestId("coach-day-workspace")).toBeVisible();
  await expect(page).toHaveScreenshot("coach-dashboard-desktop-1440.png", { fullPage: true });
});
