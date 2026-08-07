import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("@a11y supports keyboard selection from the Today athlete disclosure", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "See all athletes" }).click();
  const athlete = page.getByRole("button", { name: "Open Morgan Lee morning brief" });
  await athlete.focus();
  await expect(athlete).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Athlete profile/ })).toBeVisible();
});

test("@a11y dialog supports Escape, visible focus, and focus return", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  const adjust = page.getByRole("button", { name: "Adjust", exact: true });
  await adjust.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Adjust today’s workout" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Workout duration", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(adjust).toBeFocused();
  await expect(adjust).toHaveCSS("outline-style", "solid");
});

test("@a11y announces asynchronous Copilot status without preloading fixture charts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await expect(page.getByRole("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText(/Retrieving Sleep member context|temporarily unavailable|unavailable/i);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("@a11y has no Axe violations across the four core navigation surfaces", async ({ page }) => {
  const expectNoViolations = async () => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  };

  await page.goto("/");
  await expectNoViolations();
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expectNoViolations();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await expectNoViolations();
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await expectNoViolations();
});

test("@a11y reduces AXON signal motion when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  const signal = page.getByTestId("copilot-motion-signal");
  await expect(signal).toBeVisible();

  const animationDurationInMs = () => signal.evaluate((element) => {
    const duration = getComputedStyle(element).animationDuration;
    return duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000;
  });

  expect(await animationDurationInMs()).toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animationDurationInMs()).toBeLessThanOrEqual(1);
});

test("@a11y restores focus through nested Back and moves it to destination headings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  const workout = page.getByRole("button", { name: /Review & approve/ });
  await workout.click();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(workout).toBeFocused();

  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await expect(page.getByRole("heading", { name: "Coach Sam" })).toBeFocused();
});

test("@a11y restores focus to the exact Today entry that opened a brief", async ({ page }) => {
  await page.goto("/");
  const session = page.getByTestId("session-session_avery_20260708");
  await session.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Go back" }).click();

  await expect(session).toBeFocused();
});

test("@a11y Today destination focus wins over brief return focus", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("session-session_avery_20260708").click();
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Today" }).click();

  await expect(page.getByRole("heading", { name: "Good morning, Coach Sam" })).toBeFocused();
});

test("@a11y workout generation announces failure and returns focus for revision", async ({ page }) => {
  await page.route("**/api/workout-runs", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ status: "unavailable" }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  const prompt = page.getByRole("textbox", { name: "Workout request" });
  await prompt.fill("Build a knee-aware strength workout");
  await page.getByRole("button", { name: "Generate workout" }).click();

  await expect(page.getByRole("status")).toContainText("Workout request could not be submitted");
  const retry = page.getByRole("button", { name: "Try again" });
  await retry.focus();
  await expect(retry).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("@a11y labels the microphone, exposes disclosure status, and keeps typed recovery available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
  const microphone = page.getByRole("button", { name: "Start voice input" });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await microphone.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Before voice input", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "The transcript stays editable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow microphone & start" })).toBeVisible();
  await expect(input).toBeEnabled();
  const microphoneSize = await microphone.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
  expect(microphoneSize.width).toBeGreaterThanOrEqual(40);
  expect(microphoneSize.height).toBeGreaterThanOrEqual(40);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toBeEnabled();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
