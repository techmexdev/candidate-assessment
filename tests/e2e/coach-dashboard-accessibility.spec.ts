import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { installRichCopilotRoute } from "./copilot-test-support";

const accessibleMovementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:accessible-demo",
    authority: "canonical",
    counts: { nodes: 5, relationships: 5 },
    nodes: [
      { id: "exercise:squat", kind: "exercise", label: "Squat", category: "domain", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:squat", lineageIds: [] } },
      { id: "joint:knee-a", kind: "joint", label: "Knee", category: "domain", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:knee-a", lineageIds: [] } },
      { id: "joint:knee-b", kind: "joint", label: "Knee", category: "domain", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:knee-b", lineageIds: [] } },
      { id: "anatomy:cartilage", kind: "body-region", label: "Patellar cartilage", category: "domain", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage", lineageIds: [] } },
      { id: "muscle:glute", kind: "muscle", label: "Gluteus medius", category: "domain", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:glute", lineageIds: [] } },
    ],
    relationships: [
      { id: "assertion:targets-knee-a", kind: "targets", fromId: "exercise:squat", toId: "joint:knee-a", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:targets-knee-a", source: { locator: "movement.json#/targets/0", artifactDigest: "sha256:accessible-demo" }, lineageIds: [] } },
      { id: "assertion:targets-knee-b", kind: "targets", fromId: "exercise:squat", toId: "joint:knee-b", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:targets-knee-b", lineageIds: [] } },
      { id: "assertion:cartilage-part", kind: "part-of", fromId: "anatomy:cartilage", toId: "joint:knee-a", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage-part", lineageIds: [] } },
      { id: "assertion:knee-glute", kind: "targets", fromId: "joint:knee-b", toId: "muscle:glute", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:knee-glute", lineageIds: [] } },
      { id: "assertion:cartilage-cycle", kind: "supported-by", fromId: "anatomy:cartilage", toId: "exercise:squat", revisionId: "movement:accessible-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage-cycle", lineageIds: [] } },
    ],
  },
} as const;

async function focusDisclosureWithKeyboard(page: Page, summary: Locator): Promise<void> {
  await page.getByRole("button", { name: "Morning brief", exact: true }).focus();
  for (let step = 0; step < 20; step += 1) {
    if (await summary.evaluate((element) => element.matches(":focus-visible"))) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Disclosure summary was not reachable with keyboard focus.");
}

test("@a11y supports keyboard selection from the Today athlete roster", async ({ page }) => {
  await page.goto("/");
  const athleteSection = page.getByTestId("today-athlete-row");
  const athlete = athleteSection.getByRole("button", { name: "Open Morgan Lee morning brief" });
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
  let releaseResponse!: () => void;
  const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/copilot", async (route) => {
    await responseReady;
    await route.abort().catch(() => undefined);
  });
  try {
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
  } finally {
    releaseResponse();
    await page.unroute("**/api/copilot");
  }
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
  const athlete = page.getByTestId("today-athlete-card-mbr_02HX9AVERY");
  await athlete.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Go back" }).click();

  await expect(athlete).toBeFocused();
});

test("@a11y Today destination focus wins over brief return focus", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("today-athlete-card-mbr_02HX9AVERY").click();
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

test("@a11y keeps the typed Copilot composer usable without voice controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open voice mode" })).toHaveCount(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("@a11y keeps Copilot detail disclosures native, keyboard-operable, and complete", async ({ page }) => {
  let copilotRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/copilot") && request.method() === "POST") copilotRequests += 1;
  });

  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  const answer = page.locator('[data-copilot-presentation="workbench"]');
  await expect(answer).toBeVisible();
  await expect(answer.getByText(/member is progressing/i)).toBeVisible();
  const disclosures = answer.locator("details");
  await expect(disclosures).not.toHaveCount(0);
  const initialRequestCount = copilotRequests;
  const disclosureCount = await disclosures.count();

  for (let index = 0; index < disclosureCount; index += 1) {
    const disclosure = disclosures.nth(index);
    const summary = disclosure.locator(":scope > summary");
    await expect(summary).toHaveJSProperty("tagName", "SUMMARY");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await focusDisclosureWithKeyboard(page, summary);
    await expect(summary).toBeFocused();
    await expect(summary).toHaveCSS("outline-style", "solid");

    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    await page.keyboard.press("Space");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
  }

  const collapsedResults = await new AxeBuilder({ page }).analyze();
  expect(collapsedResults.violations).toEqual([]);

  for (let index = 0; index < disclosureCount; index += 1) {
    const disclosure = disclosures.nth(index);
    await disclosure.locator(":scope > summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
  }

  const trend = answer.getByTestId("copilot-disclosure-trend");
  if (await trend.count() > 0) {
    await expect(trend.getByRole("img")).toBeVisible();
    await expect(trend.locator("p").filter({ hasText: /percent/i })).toBeVisible();
  }
  const expandedResults = await new AxeBuilder({ page }).analyze();
  expect(expandedResults.violations).toEqual([]);
  expect(copilotRequests).toBe(initialRequestCount);
});

test("@a11y keeps Today morning brief disclosures keyboard-operable and valid when collapsed or expanded", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();

  const brief = page.locator('[data-answer-id="answer:presentation"]');
  const disclosures = brief.locator("details");
  await expect(brief).toBeVisible();
  await expect(disclosures).not.toHaveCount(0);
  const disclosureCount = await disclosures.count();

  for (let index = 0; index < disclosureCount; index += 1) {
    const disclosure = disclosures.nth(index);
    const summary = disclosure.locator(":scope > summary");
    await expect(summary).toHaveJSProperty("tagName", "SUMMARY");
    await expect(disclosure).not.toHaveAttribute("open", "");

    await page.getByRole("button", { name: "Go back" }).focus();
    for (let step = 0; step < 20 && !await summary.evaluate((element) => element.matches(":focus-visible")); step += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(summary).toBeFocused();
    await expect(summary).toHaveCSS("outline-style", "solid");

    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    await page.keyboard.press("Space");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
  }

  const collapsedResults = await new AxeBuilder({ page }).include('[data-answer-id="answer:presentation"]').analyze();
  expect(collapsedResults.violations).toEqual([]);

  for (let index = 0; index < disclosureCount; index += 1) {
    const disclosure = disclosures.nth(index);
    await disclosure.locator(":scope > summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
  }
  await expect(brief.getByTestId("copilot-disclosure-trend").getByRole("img")).toBeVisible();
  const expandedResults = await new AxeBuilder({ page }).include('[data-answer-id="answer:presentation"]').analyze();
  expect(expandedResults.violations).toEqual([]);
});

test("@a11y keeps the progressive graph native, linear, announced, and focus-stable", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accessibleMovementGraph) });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();

  const completeGraph = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
  const start = completeGraph.getByRole("button", { name: /^Start with Squat/ });
  await start.focus();
  await page.keyboard.press("Enter");

  const map = page.getByRole("region", { name: "Active relationship map" });
  const root = map.getByRole("button", { name: /^Squat · Exercise/ });
  await expect(root).toBeFocused();
  await expect(root).toHaveAttribute("aria-expanded", "false");
  await expect(map.locator("[role='tree'], [role='grid']")).toHaveCount(0);

  const firstKnee = map.getByRole("button", { name: /^Follow Knee · Joint 1 through targets/ });
  await firstKnee.focus();
  await page.keyboard.press("Enter");
  await expect(map.getByRole("button", { name: /^Knee · Joint 1 · Joint/ })).toBeFocused();
  await expect(root).toHaveAttribute("aria-expanded", "true");

  const cartilage = map.getByRole("button", { name: /Patellar cartilage.*Shared connection/ });
  await cartilage.focus();
  await page.keyboard.press("Enter");
  await expect(cartilage).toBeFocused();
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("Patellar cartilage");
  await expect(map.getByRole("button", { name: /^Patellar cartilage · Body region/ })).toHaveCount(0);

  const secondKnee = map.getByRole("button", { name: /^Follow Knee · Joint 2 through targets/ });
  await secondKnee.focus();
  await page.keyboard.press("Enter");
  const secondKneeCard = map.getByRole("button", { name: /^Knee · Joint 2 · Joint/ });
  await expect(secondKneeCard).toBeFocused();
  await expect(map.getByRole("button", { name: /^Patellar cartilage · Body region/ })).toHaveCount(0);

  const status = completeGraph.locator('[role="status"][aria-live="polite"]');
  await expect(status).toContainText("Node selected: Knee · Joint 2");
  await expect(status).not.toContainText("joint:knee-b");

  const visualEdges = map.locator("svg[aria-hidden='true']");
  const semanticEdges = map.getByRole("button", { name: /^Inspect relationship:/ });
  await expect(semanticEdges).toHaveCount(await visualEdges.count());
  for (const control of await semanticEdges.all()) {
    await expect(control).toHaveJSProperty("tagName", "BUTTON");
    await expect(control).toBeVisible();
  }

  const selectedEdge = semanticEdges.first();
  await selectedEdge.focus();
  await page.keyboard.press("Enter");
  await expect(selectedEdge).toBeFocused();
  await expect(secondKneeCard).toHaveAttribute("aria-current", "true");

  const detail = page.getByRole("region", { name: "Source and provenance details" });
  await expect(detail).toBeVisible();
  expect(await detail.evaluate((element) => (element as HTMLElement).innerText)).not.toContain("assertion:");
  const technical = detail.locator("details");
  const summary = technical.locator(":scope > summary");
  await expect(summary).toHaveJSProperty("tagName", "SUMMARY");
  await expect(technical).not.toHaveAttribute("open", "");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(technical).toHaveAttribute("open", "");
  await expect(technical).toContainText("assertion:");

  await root.focus();
  await page.keyboard.press("Enter");
  await expect(root).toBeFocused();
  await expect(root).toHaveAttribute("aria-expanded", "false");
  await expect(secondKneeCard).toHaveCount(0);

  const results = await new AxeBuilder({ page }).include('[aria-label="Movement knowledge graph"]').analyze();
  expect(results.violations).toEqual([]);
});
