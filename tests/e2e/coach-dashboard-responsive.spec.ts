import { expect, test } from "@playwright/test";

import { installRichCopilotRoute } from "./copilot-test-support";

const longLabelMovementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:responsive-demo",
    authority: "canonical",
    counts: { nodes: 3, relationships: 2 },
    nodes: [
      { id: "exercise:single-leg-reach", kind: "exercise", label: "Single-leg Romanian deadlift with contralateral reach", category: "domain", revisionId: "movement:responsive-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:single-leg-reach", lineageIds: [] } },
      { id: "rule:clinician-review", kind: "clinical-rule", label: "Clinician-reviewed movement pattern for comfortable knee loading", category: "domain", revisionId: "movement:responsive-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:clinician-review", lineageIds: [] } },
      { id: "region:posterolateral-chain", kind: "body-region", label: "Posterolateral hip and trunk stabilization chain requiring deliberate clinician-reviewed loading progression", category: "domain", revisionId: "movement:responsive-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:posterolateral-chain", lineageIds: [] } },
    ],
    relationships: [
      { id: "assertion:supported-review", kind: "substitution-candidate-for", fromId: "exercise:single-leg-reach", toId: "rule:clinician-review", revisionId: "movement:responsive-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:supported-review", lineageIds: [] } },
      { id: "assertion:requires-chain", kind: "has-constraint", fromId: "rule:clinician-review", toId: "region:posterolateral-chain", revisionId: "movement:responsive-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:requires-chain", lineageIds: [] } },
    ],
  },
} as const;

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
  await expect(page.getByRole("button", { name: /Copilot context/ })).toBeVisible();
});

test("keeps the Copilot workbench and typed composer usable without voice controls at supported widths", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
    await expect(page.getByText("Voice Copilot", { exact: true })).toHaveCount(0);
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
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
    await expect(answer.getByText("Decision", { exact: true })).toBeVisible();
    await expect(answer.getByText("Summary", { exact: true })).toHaveCount(0);
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

test("keeps the Today morning brief summaries touch-sized and expanded evidence within supported widths", async ({ page }) => {
  await installRichCopilotRoute(page);

  for (const viewport of [
    { width: 320, height: 760 },
    { width: 430, height: 932 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();

    const brief = page.locator('[data-answer-id="answer:presentation"]');
    const disclosures = brief.locator("details");
    await expect(brief).toBeVisible();
    await expect(disclosures).not.toHaveCount(0);
    const disclosureCount = await disclosures.count();
    for (let index = 0; index < disclosureCount; index += 1) {
      await expect(disclosures.nth(index)).not.toHaveAttribute("open", "");
    }

    if (viewport.width === 320) {
      const summaryBoxes = await brief.locator("details > summary").evaluateAll((summaries) => summaries.map((summary) => {
        const box = summary.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
      for (const box of summaryBoxes) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    await brief.getByTestId("copilot-disclosure-trend").locator(":scope > summary").click();
    await brief.getByTestId("copilot-disclosure-sources").locator(":scope > summary").click();
    const trendChart = brief.getByTestId("copilot-disclosure-trend").getByRole("img");
    await expect(trendChart).toBeVisible();
    await expect(brief.getByTestId("copilot-disclosure-sources")).toContainText("REVISION · member-context:sha256:");
    const trendGeometry = await brief.getByTestId("copilot-disclosure-trend").evaluate((trend) => {
      const section = trend.querySelector<HTMLElement>('[data-copilot-section="trend"]');
      const chart = trend.querySelector<HTMLElement>('[role="img"]');
      if (!section || !chart) throw new Error("Expected trend section and chart.");
      const fillTops = Array.from(chart.querySelectorAll<HTMLElement>("[data-chart-value]")).map((fill) => fill.getBoundingClientRect().top);
      return { sectionBottom: section.getBoundingClientRect().bottom, chartTop: chart.getBoundingClientRect().top, fillTops };
    });
    expect(trendGeometry.chartTop).toBeGreaterThanOrEqual(trendGeometry.sectionBottom);
    expect(Math.min(...trendGeometry.fillTops)).toBeGreaterThanOrEqual(trendGeometry.chartTop);

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      overflowingBriefElements: Array.from(document.querySelectorAll<HTMLElement>(
        '[data-answer-id="answer:presentation"], [data-answer-id="answer:presentation"] details, [data-answer-id="answer:presentation"] summary, [data-answer-id="answer:presentation"] [role="img"]',
      )).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => ({
        tag: element.tagName,
        testId: element.getAttribute("data-testid"),
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
    }));
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.overflowingBriefElements).toEqual([]);
  }
});

test("keeps progressive graph depth flat, wrapping, and page-owned at supported widths", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(longLabelMovementGraph) });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of [
    { width: 320, height: 760 },
    { width: 430, height: 932 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
    await page.getByRole("button", { name: "Show full graph" }).click();

    const completeGraph = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
    await completeGraph.getByRole("button", { name: /^Start with Single-leg Romanian deadlift/ }).click();
    const map = page.getByRole("region", { name: "Active relationship map" });
    const firstEdge = map.getByRole("button", { name: /^Inspect relationship:/ }).first();
    await expect(firstEdge).toBeVisible();
    await expect(firstEdge).toContainText("Stored direction:");
    await map.getByRole("button", { name: /^Follow Clinician-reviewed movement pattern/ }).click();
    await map.getByRole("button", { name: /^Follow Posterolateral hip and trunk stabilization chain/ }).click();

    const levels = map.locator("[data-depth]");
    await expect(levels).toHaveCount(3);
    const levelLefts = await levels.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
    expect(Math.max(...levelLefts) - Math.min(...levelLefts)).toBeLessThanOrEqual(1);

    const semanticEdge = map.getByRole("button", { name: /^Inspect relationship:/ }).last();
    const edgeText = semanticEdge.locator("span");
    await expect(edgeText).toBeVisible();
    expect(await edgeText.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("anywhere");
    expect(await semanticEdge.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    const currentNode = map.locator('button[aria-current="true"]');
    const currentLabel = currentNode.locator("strong");
    expect(await currentLabel.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("anywhere");
    expect(await currentNode.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (viewport.width < 500) {
      const lineMetrics = await currentLabel.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(lineMetrics.height).toBeGreaterThan(lineMetrics.lineHeight * 1.5);
    }

    const inventory = page.getByRole("region", { name: "Complete graph inventory" });
    await inventory.getByRole("button", { name: "Open complete inventory" }).click();
    await expect(inventory.getByRole("searchbox", { name: "Filter loaded graph inventory" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Source and provenance details" })).toBeVisible();

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      pageOwnsScroll: document.scrollingElement === document.documentElement,
      overflowingGraphElements: Array.from(document.querySelectorAll<HTMLElement>(
        '[aria-label="Movement knowledge graph"], [aria-label="Active relationship map"], [aria-label="Complete graph inventory"], [aria-label="Source and provenance details"], [data-depth], [aria-label^="Inspect relationship:"]',
      )).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.getAttribute("aria-label") ?? element.getAttribute("data-depth") ?? element.tagName),
      motionDurations: Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Movement knowledge graph"] *')).flatMap((element) => {
        const style = getComputedStyle(element);
        return `${style.animationDuration},${style.transitionDuration}`.split(",").map((value) => {
          const duration = value.trim();
          return duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000;
        });
      }),
    }));
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.pageOwnsScroll).toBe(true);
    expect(layout.overflowingGraphElements).toEqual([]);
    expect(Math.max(...layout.motionDurations)).toBeLessThanOrEqual(1);
  }
});
