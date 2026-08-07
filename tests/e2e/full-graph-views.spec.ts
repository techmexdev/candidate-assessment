import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const movementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:coach-demo",
    authority: "canonical",
    counts: { nodes: 2, relationships: 1 },
    nodes: [
      {
        id: "exercise:squat",
        kind: "exercise",
        label: "Squat",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [{ key: "catalogId", value: "exercise:squat" }],
        provenance: { directAssertion: "present", assertionId: "assertion:squat", source: { sourceId: "movement-catalog", sourceRevision: "demo" }, lineageIds: [] },
      },
      {
        id: "joint:knee",
        kind: "joint",
        label: "Knee",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:knee", source: { sourceId: "movement-catalog", sourceRevision: "demo" }, lineageIds: [] },
      },
    ],
    relationships: [{
      id: "assertion:targets",
      kind: "targets",
      fromId: "exercise:squat",
      toId: "joint:knee",
      revisionId: "movement:coach-demo",
      detail: [],
      provenance: { directAssertion: "present", assertionId: "assertion:targets", source: { sourceId: "movement-catalog", sourceRevision: "demo" }, lineageIds: [] },
    }],
  },
};

const memberGraph = {
  status: "ready",
  data: {
    domain: "member-context",
    revisionId: "context:jordan-demo",
    memberId: "mbr_01HX9JORDAN",
    authority: "canonical",
    sourceArtifactDigest: "sha256:jordan-demo",
    counts: { nodes: 2, relationships: 1 },
    nodes: [
      {
        id: "member:mbr_01HX9JORDAN",
        kind: "member",
        label: "Jordan Rivera",
        category: "identity",
        revisionId: "context:jordan-demo",
        detail: [],
        provenance: { directAssertion: "none", lineageIds: [] },
      },
      {
        id: "profile:mbr_01HX9JORDAN",
        kind: "member-profile",
        label: "Jordan Rivera profile",
        category: "domain",
        revisionId: "context:jordan-demo",
        detail: [{ key: "timezone", value: "America/Chicago" }],
        provenance: { directAssertion: "present", assertionId: "assertion:profile", source: { locator: "member-profile.json#/profile", artifactDigest: "sha256:jordan-demo" }, lineageIds: [] },
      },
    ],
    relationships: [{
      id: "assertion:has-profile",
      kind: "HAS_PROFILE",
      fromId: "member:mbr_01HX9JORDAN",
      toId: "profile:mbr_01HX9JORDAN",
      revisionId: "context:jordan-demo",
      detail: [],
      provenance: { directAssertion: "present", assertionId: "assertion:has-profile", source: { locator: "member-profile.json#/profile", artifactDigest: "sha256:jordan-demo" }, lineageIds: [] },
    }],
  },
};

test("keeps Movement focused by default and expands to the complete graph on demand", async ({ page }) => {
  let graphRequests = 0;
  await page.route("**/api/movement-graph**", async (route) => {
    graphRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(movementGraph) });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await expect(page.getByRole("button", { name: "Show full graph" })).toBeVisible();
  expect(graphRequests).toBe(0);

  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByText("2 nodes", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Movement knowledge graph complete graph" })).toBeVisible();
  expect(graphRequests).toBe(1);

  await page.getByRole("button", { name: "Squat, exercise" }).click();
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("movement-catalog");
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("assertion:squat");

  await page.getByRole("button", { name: "← Focused view" }).click();
  await expect(page.getByRole("button", { name: "Show full graph" })).toBeVisible();
});

test("@a11y keeps the full Movement graph keyboard-selectable and violation-free", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(movementGraph) });
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByRole("region", { name: "Movement knowledge graph complete graph" })).toBeVisible();

  const knee = page.getByRole("button", { name: "Knee, joint" });
  await knee.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("movement:coach-demo");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("keeps the member profile focused by default and reads only the selected member graph", async ({ page }) => {
  let graphRequests = 0;
  await page.route("**/api/member-context/graph**", async (route) => {
    graphRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memberGraph) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Athlete profile/ }).click();
  await expect(page.getByRole("button", { name: "Show full graph" })).toBeVisible();
  expect(graphRequests).toBe(0);

  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByText("2 nodes", { exact: true })).toBeVisible();
  expect(graphRequests).toBe(1);
  await page.getByRole("button", { name: "Jordan Rivera, member" }).click();
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("none · identity or lineage node");
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("context:jordan-demo");
});
