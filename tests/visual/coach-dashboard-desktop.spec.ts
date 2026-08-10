import { expect, test, type Page } from "@playwright/test";

import { installRichCopilotRoute } from "../e2e/copilot-test-support";

const visualMovementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:visual-demo",
    authority: "canonical",
    counts: { nodes: 4, relationships: 4 },
    nodes: [
      { id: "exercise:squat", kind: "exercise", label: "Squat pattern", category: "domain", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:squat", lineageIds: [] } },
      { id: "joint:knee", kind: "joint", label: "Knee", category: "domain", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:knee", lineageIds: [] } },
      { id: "anatomy:cartilage", kind: "body-region", label: "Patellar cartilage", category: "domain", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage", lineageIds: [] } },
      { id: "rule:knee-flexion", kind: "clinical-rule", label: "Comfortable loaded knee flexion", category: "domain", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:rule", lineageIds: [] } },
    ],
    relationships: [
      { id: "assertion:targets-knee", kind: "targets", fromId: "exercise:squat", toId: "joint:knee", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:targets-knee", lineageIds: [] } },
      { id: "assertion:cartilage-part", kind: "part-of", fromId: "anatomy:cartilage", toId: "joint:knee", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage-part", source: { locator: "movement.json#/anatomy/0", artifactDigest: "sha256:visual-movement" }, lineageIds: [] } },
      { id: "assertion:rule-knee", kind: "cautions", fromId: "rule:knee-flexion", toId: "joint:knee", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:rule-knee", lineageIds: [] } },
      { id: "assertion:cartilage-cycle", kind: "supported-by", fromId: "anatomy:cartilage", toId: "exercise:squat", revisionId: "movement:visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:cartilage-cycle", lineageIds: [] } },
    ],
  },
} as const;

const visualMemberGraph = {
  status: "ready",
  data: {
    domain: "member-context",
    revisionId: "context:jordan-visual-demo",
    memberId: "mbr_01HX9JORDAN",
    authority: "canonical",
    sourceArtifactDigest: "sha256:visual-member",
    counts: { nodes: 4, relationships: 3 },
    nodes: [
      { id: "member:mbr_01HX9JORDAN", kind: "member", label: "Jordan Rivera", category: "identity", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "none", lineageIds: [] } },
      { id: "profile:jordan", kind: "member-profile", label: "Jordan Rivera training profile", category: "domain", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:profile", lineageIds: [] } },
      { id: "goal:strength", kind: "goal", label: "Build durable lower-body strength", category: "domain", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:goal", lineageIds: [] } },
      { id: "evidence:checkin", kind: "observation", label: "Wednesday readiness check-in", category: "domain", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:evidence", lineageIds: [] } },
    ],
    relationships: [
      { id: "assertion:has-profile", kind: "HAS_PROFILE", fromId: "member:mbr_01HX9JORDAN", toId: "profile:jordan", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:has-profile", lineageIds: [] } },
      { id: "assertion:has-goal", kind: "PURSUES", fromId: "profile:jordan", toId: "goal:strength", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:has-goal", source: { locator: "member-context.json#/goals/0", artifactDigest: "sha256:visual-member" }, lineageIds: [] } },
      { id: "assertion:supported", kind: "SUPPORTED_BY", fromId: "evidence:checkin", toId: "goal:strength", revisionId: "context:jordan-visual-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:supported", lineageIds: [] } },
    ],
  },
} as const;

async function openMovementGraph(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await page.getByRole("button", { name: /^Start with Squat pattern/ }).click();
  await page.getByRole("button", { name: /^Follow Knee through targets/ }).click();
  await page.getByRole("button", { name: /Patellar cartilage.*Shared connection/ }).click();
}

async function openMemberGraph(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Athlete profile/ }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await page.getByRole("button", { name: /^Follow Jordan Rivera training profile through has profile/ }).click();
  await page.getByRole("button", { name: /^Follow Build durable lower-body strength through pursues/ }).click();
}

test("@visual flagship coach dashboard desktop projection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByTestId("coach-day-workspace")).toBeVisible();
  await expect(page).toHaveScreenshot("coach-dashboard-desktop-1440.png", { fullPage: true });
});

test("@visual selected-member Copilot workbench desktop density", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const answer = page.locator('[data-copilot-presentation="workbench"]');
  await expect(answer).toBeVisible();
  await expect(page).toHaveScreenshot("copilot-workbench-desktop-default.png", { fullPage: true });

  const disclosures = answer.locator("details");
  for (let index = 0; index < await disclosures.count(); index += 1) {
    await disclosures.nth(index).locator(":scope > summary").click();
  }
  await expect(page).toHaveScreenshot("copilot-workbench-desktop-expanded.png", { fullPage: true });
});

test("@visual Today morning brief desktop progressive disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installRichCopilotRoute(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();

  const brief = page.locator('[data-answer-id="answer:presentation"]');
  await expect(brief).toBeVisible();
  await brief.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(page).toHaveScreenshot("morning-brief-desktop-collapsed.png");

  const disclosures = brief.locator("details");
  await disclosures.evaluateAll((elements) => elements.forEach((element) => element.setAttribute("open", "")));
  await brief.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(page).toHaveScreenshot("morning-brief-desktop-expanded.png");
});

test("@visual expanded Movement graph desktop branch", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(visualMovementGraph) });
  });
  await openMovementGraph(page);
  await expect(page).toHaveScreenshot("movement-graph-expanded-desktop-1440.png", { fullPage: true });
});

test("@visual expanded member-context graph desktop branch", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/member-context/graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(visualMemberGraph) });
  });
  await openMemberGraph(page);
  await expect(page).toHaveScreenshot("member-context-graph-expanded-desktop-1440.png", { fullPage: true });
});
