import { expect, test, type Page } from "@playwright/test";

async function expectVisibleGraphAction(page: Page) {
  const action = page.getByRole("button", { name: "Show full graph" });
  await expect(action).toBeVisible();
  await expect(action).toHaveCSS("background-color", "rgb(17, 17, 17)");
  await expect(action).toHaveCSS("color", "rgb(255, 255, 255)");
}

test("keeps graph expansion actions visually available at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 366, height: 334 });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await page.getByRole("button", { name: "Decision path →" }).first().click();
  await expectVisibleGraphAction(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: "Athlete profile" }).click();
  await expectVisibleGraphAction(page);
});
