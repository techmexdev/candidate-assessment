import { expect, test } from "@playwright/test";

test("uses the same two-destination hierarchy on wide screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const dashboard = page.getByTestId("desktop-dashboard");
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button")).toHaveText(["Today", "Coach"]);
  await expect(page.getByTestId("today-calendar")).toBeVisible();

  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(dashboard.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button")).toHaveText(["Today", "Coach"]);
});

test("preserves nested athlete state while resizing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await expect(page.getByRole("region", { name: "Workout" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole("region", { name: "Workout" })).toBeVisible();
  await expect(page.getByTestId("desktop-dashboard")).toBeVisible();

  await page.setViewportSize({ width: 430, height: 932 });
  await expect(page.getByRole("region", { name: "Workout" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button")).toHaveText(["Today", "Coach"]);
});

test("remains usable without horizontal page overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/");
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
  await expect(page.getByRole("navigation", { name: "Dashboard sections" })).toBeVisible();
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expect(page.getByRole("button", { name: /Talk through today/ })).toBeVisible();
});
