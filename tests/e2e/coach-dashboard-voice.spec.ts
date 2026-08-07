import { expect, test } from "@playwright/test";

test("Copilot opens the nested voice surface without fabricating a grounded answer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Open voice mode" }).click();

  await expect(page.getByRole("region", { name: "Voice mode" })).toBeVisible();
  await expect(page.getByText("Continue in text Copilot")).toBeVisible();
  await expect(page.getByText(/No fixture or graph-backed voice answer will be generated/)).toBeVisible();
  await expect(page.getByRole("button", { name: /voice input/i })).toHaveCount(0);
});

test("voice mode returns to Copilot instead of becoming a primary tab", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  await expect(page.getByRole("button", { name: "Open voice mode" })).toBeVisible();
  const voiceTrigger = page.getByRole("button", { name: "Open voice mode" });
  await voiceTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Voice mode" })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("region", { name: "Copilot" })).toBeVisible();
  await expect(voiceTrigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Voice", exact: true })).toHaveCount(0);
});

test("voice does not claim note capture when speech transport is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Avery Chen morning brief" }).first().click();
  await page.getByRole("button", { name: /Talk through today/ }).click();
  await expect(page.getByText("Continue in text Copilot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log a voice note" })).toHaveCount(0);
  await expect(page.getByText(/Draft note captured/)).toHaveCount(0);
});
