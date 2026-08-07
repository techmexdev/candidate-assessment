import { expect, test } from "@playwright/test";

test("starts with profile-first Today and exactly two enabled destinations", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Dashboard sections" });

  await expect(navigation.getByRole("button")).toHaveText(["Today", "Coach"]);
  await expect(navigation.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Coach" })).toBeEnabled();
  await expect(page.getByTestId("today-profile-item")).toContainText("Avery Chen");
  await expect(page.getByTestId("today-profile-item")).toContainText("Plus · 3 days/wk");

  const order = await page.evaluate(() => {
    const profile = document.querySelector('[data-testid="today-profile-item"]');
    const calendar = document.querySelector('[data-testid="today-calendar"]');
    const athletes = document.querySelector('[data-testid="today-athlete-row"]');
    const schedule = document.querySelector('[data-testid="today-schedule"]');
    if (!profile || !calendar || !athletes || !schedule) return [];
    return [profile, calendar, athletes, schedule]
      .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .map((element) => element.getAttribute("data-testid"));
  });
  expect(order).toEqual(["today-profile-item", "today-calendar", "today-athlete-row", "today-schedule"]);
  await expect(page.getByTestId("today-athlete-row")).toContainText("knee-safe strength");
  await expect(page.getByTestId("today-schedule")).toContainText(/min/);
  const profile = page.getByTestId("today-profile-item");
  await profile.focus();
  await expect(profile).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Go back" })).toBeVisible();
  await expect(page.getByText("Avery Chen", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("member-brief-date")).toContainText("WED");
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(profile).toBeFocused();
});

test("changing to an empty day refreshes Today while keeping all athletes available", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("week-day-2026-07-09").click();

  await expect(page.getByTestId("week-day-2026-07-09")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("today-profile-item")).toHaveCount(0);
  await expect(page.getByTestId("athletes-empty")).toContainText("No athletes scheduled");
  await expect(page.getByTestId("agenda-empty")).toContainText("No sessions scheduled");
  await page.getByRole("button", { name: "See all athletes" }).click();
  await expect(page.getByRole("button", { name: "Open Avery Chen morning brief" })).toBeVisible();
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).click();
  await expect(page.getByTestId("member-brief-date")).toContainText("THU");
  await expect(page.getByTestId("member-brief-date")).toContainText("JUL 9");
  await expect(page.getByText("DRAFT FOR THURSDAY, JULY 9 · READY", { exact: true })).toBeVisible();
});

test("keeps all athletes inside Today and opens one unified morning brief", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "See all athletes" }).click();
  await expect(page.getByRole("button", { name: "Open Morgan Lee morning brief" })).toBeVisible();
  await page.getByRole("button", { name: "Open Morgan Lee morning brief" }).click();

  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(page.getByText("MORNING BRIEF TOOLS", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copilot context/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Talk through today/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Morgan Lee profile/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("button", { name: "Hide all athletes" })).toBeVisible();
});

test("nests workout rationale and decision paths under the athlete brief", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await expect(page.getByRole("region", { name: "Workout" })).toBeVisible();
  await page.getByRole("button", { name: "Why this workout?" }).click();
  await expect(page.getByRole("region", { name: "Workout rationale" })).toBeVisible();
  await page.getByRole("button", { name: "See decision path" }).first().click();
  await expect(page.getByRole("region", { name: "Decision Path" })).toBeVisible();

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("region", { name: "Workout rationale" })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("region", { name: "Workout" })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
});

test("retains an athlete adjustment after visiting Coach and returning", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByRole("slider", { name: "Workout duration", exact: true }).fill("40");
  await page.getByRole("button", { name: "Apply adjustment" }).click();
  await expect(page.getByRole("dialog", { name: "Adjust today’s workout" })).not.toBeVisible({ timeout: 2_000 });

  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await expect(page.getByRole("heading", { name: "Coach Sam" })).toBeVisible();
  await expect(page.getByText("America/Chicago")).toBeVisible();
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Today" }).click();
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();
  await expect(page.getByRole("heading", { name: "40-min knee-safe strength" })).toBeVisible();
});
