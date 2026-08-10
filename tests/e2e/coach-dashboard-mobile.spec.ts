import { expect, test } from "@playwright/test";

const mobileMemberGraph = {
  status: "ready",
  data: {
    domain: "member-context",
    revisionId: "context:jordan-mobile-demo",
    memberId: "mbr_01HX9JORDAN",
    authority: "canonical",
    sourceArtifactDigest: "sha256:jordan-mobile-demo",
    counts: { nodes: 3, relationships: 4 },
    nodes: [
      { id: "member:mbr_01HX9JORDAN", kind: "member", label: "Jordan Rivera", category: "identity", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "none", lineageIds: [] } },
      { id: "goal:strength-a", kind: "goal", label: "Build durable strength", category: "domain", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:strength-a", lineageIds: [] } },
      { id: "goal:strength-b", kind: "goal", label: "Build durable strength", category: "domain", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:strength-b", lineageIds: [] } },
    ],
    relationships: [
      { id: "assertion:has-goal-a", kind: "PURSUES", fromId: "member:mbr_01HX9JORDAN", toId: "goal:strength-a", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:has-goal-a", lineageIds: [] } },
      { id: "assertion:has-goal-b", kind: "PURSUES", fromId: "member:mbr_01HX9JORDAN", toId: "goal:strength-b", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:has-goal-b", lineageIds: [] } },
      { id: "assertion:goal-support", kind: "SUPPORTED_BY", fromId: "goal:strength-a", toId: "goal:strength-b", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:goal-support", source: { locator: "member-context.json#/goals/1", artifactDigest: "sha256:jordan-mobile-demo" }, lineageIds: [] } },
      { id: "assertion:goal-cycle", kind: "WAS_DERIVED_FROM", fromId: "goal:strength-b", toId: "member:mbr_01HX9JORDAN", revisionId: "context:jordan-mobile-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:goal-cycle", lineageIds: [] } },
    ],
  },
} as const;

test("starts with Today content and a full vertical athlete roster", async ({ page }) => {
  await page.goto("/");
  const signIn = page.getByRole("button", { name: "Continue as demo coach" });
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  const navigation = page.getByRole("navigation", { name: "Dashboard sections" });

  await expect(navigation.getByRole("button")).toHaveText(["Today", "Coach"]);
  await expect(navigation.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Coach" })).toBeEnabled();
  await expect(navigation).not.toContainText("Avery Chen");
  await expect(page.getByTestId("today-profile-item")).toHaveCount(0);

  const order = await page.evaluate(() => {
    const overview = document.querySelector('[data-destination-heading="today"]');
    const calendar = document.querySelector('[data-testid="today-calendar"]');
    const athletes = document.querySelector('[data-testid="today-athlete-row"]');
    if (!overview || !calendar || !athletes) return [];
    return [overview, calendar, athletes]
      .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .map((element) => element.getAttribute("data-testid") ?? "today-overview-heading");
  });
  expect(order).toEqual(["today-overview-heading", "today-calendar", "today-athlete-row"]);
  const athleteSection = page.getByTestId("today-athlete-row");
  await expect(athleteSection).toContainText("TODAY’S ATHLETES");
  await expect(athleteSection).toContainText("ALL ATHLETES");
  await expect(athleteSection).toContainText("knee-safe strength");
  await expect(athleteSection.getByRole("button", { name: "Open Morgan Lee morning brief" })).toBeVisible();
  await expect(page.getByTestId("today-schedule")).toHaveCount(0);
  await expect(page.getByText("Suggested workouts", { exact: true })).toHaveCount(0);
});

test("places member information above the Wednesday draft inside the brief", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Avery Chen morning brief" }).first().click();

  const memberSummary = page.getByTestId("member-brief-summary");
  await expect(page.getByTestId("member-brief-date").locator("..")).not.toContainText("Avery Chen");
  await expect(memberSummary).toContainText("Avery Chen");
  await expect(memberSummary).toContainText("Plus · 3 days/wk");
  await expect(page.getByText("DRAFT FOR WEDNESDAY, JULY 8 · READY", { exact: true })).toBeVisible();

  const summaryBeforeDraft = await page.evaluate(() => {
    const summary = document.querySelector('[data-testid="member-brief-summary"]');
    const draft = document.querySelector('[data-focus-key="brief-workout"]');
    return Boolean(summary && draft && (summary.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(summaryBeforeDraft).toBe(true);
});

test("changing to an empty day refreshes Today while keeping all athletes available", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("week-day-2026-07-09").click();

  await expect(page.getByTestId("week-day-2026-07-09")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("athletes-empty")).toContainText("No athletes scheduled");
  const athleteSection = page.getByTestId("today-athlete-row");
  await expect(athleteSection.getByRole("button", { name: "Open Avery Chen morning brief" })).toBeVisible();
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).click();
  await expect(page.getByTestId("member-brief-date")).toContainText("THU");
  await expect(page.getByTestId("member-brief-date")).toContainText("JUL 9");
  await expect(page.getByText("DRAFT FOR THURSDAY, JULY 9 · READY", { exact: true })).toBeVisible();
});

test("keeps all athletes inside Today and opens one unified morning brief", async ({ page }) => {
  await page.goto("/");
  const athleteSection = page.getByTestId("today-athlete-row");
  await expect(athleteSection.getByRole("button", { name: "Open Morgan Lee morning brief" })).toBeVisible();
  await expect(athleteSection.getByRole("button", { name: "Open Avery Chen morning brief" })).toHaveCount(1);
  await expect(athleteSection.getByRole("button", { name: "Open Jordan Rivera morning brief" })).toHaveCount(1);
  await page.getByRole("button", { name: "Open Morgan Lee morning brief" }).click();

  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(page.getByText("MORNING BRIEF TOOLS", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copilot context/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Talk through today/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Open Morgan Lee profile/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(athleteSection.getByRole("button", { name: "Open Morgan Lee morning brief" })).toBeVisible();
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

test("keeps the seeded member graph complete, cycle-safe, and readable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.route("**/api/member-context/graph**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("memberId")).toBe("mbr_01HX9JORDAN");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mobileMemberGraph) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Athlete profile/ }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();

  const completeGraph = page.getByRole("region", { name: "Member context graph complete graph" });
  const map = page.getByRole("region", { name: "Active relationship map" });
  await expect(map.getByRole("button", { name: /^Jordan Rivera · Member/ })).toHaveAttribute("aria-current", "true");
  await expect(completeGraph).not.toContainText("Movement knowledge graph");
  expect(await completeGraph.evaluate((element) => (element as HTMLElement).innerText)).not.toMatch(/mbr_01HX9JORDAN|goal:strength|assertion:/);

  const firstGoal = map.getByRole("button", { name: /^Follow Build durable strength · Goal 1 through pursues/ });
  await firstGoal.focus();
  await page.keyboard.press("Enter");
  await expect(map.getByRole("button", { name: /^Build durable strength · Goal 1 · Goal/ })).toBeFocused();

  const sharedGoal = map
    .getByRole("region", { name: "outgoing supported by relationships" })
    .getByRole("button", { name: /Build durable strength · Goal 2.*Shared connection/ });
  await sharedGoal.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("Build durable strength · Goal 2");
  await expect(map.getByRole("button", { name: /^Build durable strength · Goal 2 · Goal/ })).toHaveCount(0);

  const secondGoal = map.getByRole("button", { name: /^Follow Build durable strength · Goal 2 through incoming connection · reverse of was derived from/ });
  await secondGoal.focus();
  await page.keyboard.press("Enter");
  await expect(map.getByRole("button", { name: /^Build durable strength · Goal 2 · Goal/ })).toBeFocused();
  await expect(map).toContainText("Already in this path");
  await expect(map.getByRole("button", { name: /^Jordan Rivera · Member/ })).toHaveCount(1);

  const controls = map.getByRole("button", { name: /^Inspect relationship:/ });
  await expect(controls).not.toHaveCount(0);
  for (const control of await controls.all()) {
    const size = await control.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    await expect(control).toContainText("Stored direction:");
  }

  const inventory = page.getByRole("region", { name: "Complete graph inventory" });
  await inventory.getByRole("button", { name: "Open complete inventory" }).click();
  await inventory.getByRole("searchbox", { name: "Filter loaded graph inventory" }).fill("supported by");
  await expect(inventory).toContainText("1 matching relationship");
  await expect(inventory.getByRole("button", { name: /Build durable strength · Goal 1 → supported by → Build durable strength · Goal 2/ })).toBeVisible();

  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
  await page.getByRole("button", { name: "← Focused view" }).click();
  await expect(page.getByText("Jordan Rivera · identity, goals, preferences, equipment, and activity.")).toBeVisible();
});
