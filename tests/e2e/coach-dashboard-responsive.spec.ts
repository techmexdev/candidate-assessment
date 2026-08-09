import { expect, test } from "@playwright/test";

import { installRichCopilotRoute } from "./copilot-test-support";

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

test("keeps the Copilot workbench, typed fallback, and disclosure usable at supported widths", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 760 },
    { width: 430, height: 932 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
    await page.getByRole("button", { name: /Copilot context/ }).click();

    await expect(page.getByRole("region", { name: "Copilot" })).toBeVisible();
    await expect(page.getByRole("button", { name: "What changed since last week?", exact: true })).toBeVisible();
    const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);

    await page.getByRole("button", { name: "Start voice input" }).click();
    await expect(page.getByText("Before voice input", { exact: true })).toBeVisible();
    await expect(input).toBeEnabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});

test("keeps the concise Copilot card and expanded evidence within supported widths", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 760 },
    { width: 430, height: 932 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await installRichCopilotRoute(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
    await page.getByRole("button", { name: /Copilot context/ }).click();

    const answer = page.locator('[data-copilot-presentation="workbench"]');
    await expect(answer).toBeVisible();
    await expect(answer.getByText(/member is progressing/i)).toBeVisible();
    const disclosures = answer.locator("details");
    await expect(disclosures).not.toHaveCount(0);
    const disclosureCount = await disclosures.count();
    for (let index = 0; index < disclosureCount; index += 1) {
      const disclosure = disclosures.nth(index);
      await expect(disclosure).not.toHaveAttribute("open", "");
      await disclosure.locator(":scope > summary").click();
      await expect(disclosure).toHaveAttribute("open", "");
    }

    const overflowingElements = await page.evaluate(() => Array.from(document.querySelectorAll(
      '[data-copilot-presentation="workbench"], [data-testid^="copilot-disclosure-"], textarea',
    )).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => ({
      tag: element.tagName,
      testId: element.getAttribute("data-testid"),
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })));
    expect(overflowingElements).toEqual([]);
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
    await expect(page.getByRole("textbox", { name: "Ask about Jordan Rivera" })).toBeVisible();
  }
});
