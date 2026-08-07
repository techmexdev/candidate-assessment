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
