import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const movementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:coach-demo",
    authority: "canonical",
    counts: { nodes: 6, relationships: 6 },
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
      {
        id: "joint:hip",
        kind: "joint",
        label: "Hip",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:hip", source: { sourceId: "movement-catalog", sourceRevision: "demo" }, lineageIds: [] },
      },
      {
        id: "anatomy:cartilage",
        kind: "body-region",
        label: "Patellar cartilage",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:cartilage", source: { sourceRecordId: "record-21" }, lineageIds: [] },
      },
      {
        id: "muscle:gluteus-medius",
        kind: "muscle",
        label: "Gluteus medius",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:glute", lineageIds: [] },
      },
      {
        id: "rule:knee-range",
        kind: "clinical-rule",
        label: "Comfortable knee range",
        category: "domain",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:rule", lineageIds: [] },
      },
    ],
    relationships: [
      {
        id: "assertion:targets-knee",
        kind: "targets",
        fromId: "exercise:squat",
        toId: "joint:knee",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:targets-knee", source: { locator: "movement.json#/targets/0", artifactDigest: "sha256:movement-demo" }, lineageIds: [] },
      },
      {
        id: "assertion:targets-hip",
        kind: "targets",
        fromId: "exercise:squat",
        toId: "joint:hip",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:targets-hip", lineageIds: [] },
      },
      {
        id: "assertion:cartilage-part",
        kind: "part-of",
        fromId: "anatomy:cartilage",
        toId: "joint:knee",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:cartilage-part", lineageIds: [] },
      },
      {
        id: "assertion:hip-glute",
        kind: "targets",
        fromId: "joint:hip",
        toId: "muscle:gluteus-medius",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:hip-glute", lineageIds: [] },
      },
      {
        id: "assertion:cartilage-cycle",
        kind: "supported-by",
        fromId: "anatomy:cartilage",
        toId: "exercise:squat",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:cartilage-cycle", lineageIds: [] },
      },
      {
        id: "assertion:rule-knee",
        kind: "cautions",
        fromId: "rule:knee-range",
        toId: "joint:knee",
        revisionId: "movement:coach-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: "assertion:rule-knee", lineageIds: [] },
      },
    ],
  },
} as const;

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
} as const;

const denseMovementGraph = {
  status: "ready",
  data: {
    domain: "movement-clinical",
    revisionId: "movement:dense-demo",
    authority: "canonical",
    counts: { nodes: 29, relationships: 28 },
    nodes: [
      { id: "graph:revision", kind: "graph-revision", label: "Revision one", category: "lineage", revisionId: "movement:dense-demo", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:revision", lineageIds: [] } },
      ...Array.from({ length: 28 }, (_, index) => ({
        id: `exercise:hub-${index}`,
        kind: "exercise",
        label: `Hub exercise ${index}`,
        category: "domain",
        revisionId: "movement:dense-demo",
        detail: [],
        provenance: { directAssertion: "present", assertionId: `assertion:hub-node-${index}`, lineageIds: [] },
      })),
    ],
    relationships: Array.from({ length: 28 }, (_, index) => ({
      id: `assertion:hub-${index}`,
      kind: "in-revision",
      fromId: "graph:revision",
      toId: `exercise:hub-${index}`,
      revisionId: "movement:dense-demo",
      detail: [],
      provenance: { directAssertion: "present", assertionId: `assertion:hub-${index}`, lineageIds: [] },
    })),
  },
} as const;

const partlyConnectedMovementGraph = {
  ...movementGraph,
  data: {
    ...movementGraph.data,
    counts: { nodes: 3, relationships: 1 },
    nodes: [movementGraph.data.nodes[0], movementGraph.data.nodes[1], movementGraph.data.nodes[2]],
    relationships: [movementGraph.data.relationships[0]],
  },
} as const;

async function openMovementGraph(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByRole("region", { name: "Movement knowledge graph complete graph" })).toBeVisible();
}

test("follows a human-readable Movement branch, switches siblings, inspects detail, filters inventory, and returns focus", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/movement-graph**", async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(movementGraph) });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  const focusedTrigger = page.getByRole("button", { name: "Show full graph" });
  await expect(focusedTrigger).toBeVisible();
  expect(requests).toHaveLength(0);
  await focusedTrigger.click();

  const completeGraph = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
  await expect(completeGraph).toContainText("Select a node to follow connections.");
  await expect(completeGraph.getByRole("button", { name: /^Start with Squat · Exercise · 3 relationships$/ })).toBeVisible();
  await expect(completeGraph).not.toContainText("exercise:squat");
  await expect(completeGraph).not.toContainText("movement:coach-demo");
  await expect(completeGraph).not.toContainText("assertion:targets-knee");

  await completeGraph.getByRole("button", { name: /^Start with Squat/ }).click();
  const map = page.getByRole("region", { name: "Active relationship map" });
  await expect(map).toBeVisible();
  await expect(map.locator("svg[aria-hidden='true'] text").filter({ hasText: "targets" }).first()).toBeVisible();
  const inspectTargets = map.getByRole("button", { name: "Inspect relationship: Squat → targets → Knee" });
  await expect(inspectTargets).toBeVisible();
  await inspectTargets.click();
  await expect(map.getByRole("button", { name: /^Squat · Exercise/ })).toHaveAttribute("aria-current", "true");
  expect(requests).toHaveLength(1);

  const detail = page.getByRole("region", { name: "Source and provenance details" });
  await expect(detail).toContainText("Targets");
  await expect(detail).toContainText("Pinned to the loaded graph revision");
  expect(await detail.evaluate((element) => (element as HTMLElement).innerText)).not.toContain("assertion:targets-knee");
  const technical = detail.locator("details");
  await expect(technical).not.toHaveAttribute("open", "");
  await technical.getByText("Technical reference", { exact: true }).click();
  await expect(technical).toContainText("assertion:targets-knee");
  await expect(technical).toContainText("movement:coach-demo");
  await expect(technical).toContainText("movement.json#/targets/0");
  await expect(technical).toContainText("sha256:movement-demo");
  await technical.getByRole("button", { name: "Refresh technical reference" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.searchParams.get("entityId")).toBe("assertion:targets-knee");
  expect(requests[1]!.searchParams.get("entityKind")).toBe("relationship");
  await expect(technical).toContainText("Technical reference refreshed.");
  await expect(map.getByRole("button", { name: /^Squat · Exercise/ })).toHaveAttribute("aria-current", "true");

  await map.getByRole("button", { name: /^Follow Knee through targets/ }).click();
  await expect(map.getByRole("button", { name: /^Knee · Joint/ })).toHaveAttribute("aria-current", "true");
  await expect(map.getByRole("button", { name: /^Follow Patellar cartilage through has part · reverse of part of/ })).toHaveCount(0);
  const sharedPatellar = map.getByRole("button", { name: /Patellar cartilage.*Shared connection/ });
  await expect(sharedPatellar).toBeVisible();
  await sharedPatellar.click();
  await expect(page.getByRole("region", { name: "Source and provenance details" })).toContainText("Patellar cartilage");

  const hipSibling = map.getByRole("button", { name: /^Follow Hip through targets/ });
  await hipSibling.click();
  await expect(map.getByRole("button", { name: /^Hip · Joint/ })).toHaveAttribute("aria-current", "true");
  await expect(map.getByRole("button", { name: /^Patellar cartilage · Body region/ })).toHaveCount(0);
  await map.getByRole("button", { name: /^Follow Gluteus medius through targets/ }).click();
  await expect(map.getByRole("button", { name: /^Gluteus medius · Muscle/ })).toHaveAttribute("aria-current", "true");

  const hipNode = map.getByRole("button", { name: /^Hip · Joint/ });
  await hipNode.click();
  await expect(hipNode).toBeFocused();
  await expect(map.getByRole("button", { name: /^Gluteus medius · Muscle/ })).toHaveCount(0);

  const inventory = page.getByRole("region", { name: "Complete graph inventory" });
  await inventory.getByRole("button", { name: "Open complete inventory" }).click();
  await inventory.getByRole("searchbox", { name: "Filter loaded graph inventory" }).fill("comfortable knee range");
  await expect(inventory).toContainText("1 matching node");
  await inventory.getByRole("button", { name: /^Use Comfortable knee range as branch root/ }).click();
  await expect(map.getByRole("button", { name: /^Comfortable knee range · Clinical rule/ })).toHaveAttribute("aria-current", "true");

  await page.getByRole("button", { name: "Reset relationship map" }).click();
  await expect(completeGraph).toContainText("Select a node to follow connections.");
  await page.getByRole("button", { name: "← Focused view" }).click();
  await expect(focusedTrigger).toBeVisible();
  await expect(focusedTrigger).toBeFocused();
});

test("reports failed and topology-changing technical-reference refreshes", async ({ page }) => {
  let inspectionRequests = 0;
  await page.route("**/api/movement-graph**", async (route) => {
    inspectionRequests += 1;
    if (inspectionRequests === 2) {
      await route.fulfill({ status: 500, contentType: "application/json", body: "refresh failed" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(inspectionRequests === 3
        ? {
            ...movementGraph,
            data: {
              ...movementGraph.data,
              relationships: [
                movementGraph.data.relationships[0],
                { ...movementGraph.data.relationships[1], id: "assertion:targets-rule", toId: "rule:knee-range" },
                ...movementGraph.data.relationships.slice(2),
              ],
            },
          }
        : movementGraph),
    });
  });
  await openMovementGraph(page);
  const completeGraph = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
  await completeGraph.getByRole("button", { name: /^Start with Squat/ }).click();
  await page.getByRole("button", { name: "Inspect relationship: Squat → targets → Knee" }).click();
  const technical = page.getByRole("region", { name: "Source and provenance details" }).locator("details");
  await technical.getByText("Technical reference", { exact: true }).click();
  const refresh = technical.getByRole("button", { name: "Refresh technical reference" });
  await refresh.click();
  await expect(technical).toContainText("Technical reference refresh failed.");
  await refresh.click();
  await expect.poll(() => inspectionRequests).toBe(3);
  await expect(technical).toContainText("Technical reference unchanged because the graph topology changed.");
});

test("shows the connection empty state for an isolated root in a partly connected graph", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(partlyConnectedMovementGraph) });
  });
  await openMovementGraph(page);
  const inventory = page.getByRole("region", { name: "Complete graph inventory" });
  await inventory.getByRole("button", { name: "Open complete inventory" }).click();
  await inventory.getByRole("button", { name: "Use Hip as branch root" }).click();
  await expect(page.getByRole("region", { name: "Active relationship map" })).toContainText("No relationships connect to this node in this snapshot.");
});

test("seeds the authorized member identity and keeps member context separate from Movement", async ({ page }) => {
  let graphRequests = 0;
  await page.route("**/api/member-context/graph**", async (route) => {
    graphRequests += 1;
    expect(new URL(route.request().url()).searchParams.get("memberId")).toBe("mbr_01HX9JORDAN");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memberGraph) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Athlete profile/ }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();

  const map = page.getByRole("region", { name: "Active relationship map" });
  await expect(map.getByRole("button", { name: /^Jordan Rivera · Member/ })).toHaveAttribute("aria-current", "true");
  await expect(map.getByRole("button", { name: /^Follow Jordan Rivera profile through has profile/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Member context graph complete graph" })).not.toContainText("Squat");
  await expect(page.getByRole("region", { name: "Member context graph complete graph" })).not.toContainText("mbr_01HX9JORDAN");
  expect(graphRequests).toBe(1);

  await page.getByRole("button", { name: "← Focused view" }).click();
  await expect(page.getByText("Jordan Rivera · identity, goals, preferences, equipment, and activity.")).toBeVisible();
});

test("bundles more than twelve incident relationships while inventory retains every relationship", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(denseMovementGraph) });
  });
  await openMovementGraph(page);

  await page.getByRole("button", { name: /^Start with Revision one/ }).click();
  const map = page.getByRole("region", { name: "Active relationship map" });
  const bundle = map.getByRole("button", { name: "Outgoing in revision relationships, 0 visible of 28 total" });
  await expect(bundle).toHaveAttribute("aria-expanded", "false");
  await bundle.click();
  const expandedBundle = map.getByRole("button", { name: "Outgoing in revision relationships, 12 visible of 28 total" });
  await expect(expandedBundle).toHaveAttribute("aria-expanded", "true");
  await expect(map.getByRole("button", { name: /^Inspect relationship:/ })).toHaveCount(12);

  const inventory = page.getByRole("region", { name: "Complete graph inventory" });
  await inventory.getByRole("button", { name: "Open complete inventory" }).click();
  await inventory.getByRole("searchbox", { name: "Filter loaded graph inventory" }).fill("Hub exercise 27");
  await expect(inventory).toContainText("1 matching relationship");
  await expect(inventory.getByRole("button", { name: /Revision one → in revision → Hub exercise 27/ })).toBeVisible();
});

test("labels partial data truthfully and withholds branch controls until paging completes", async ({ page }) => {
  let releaseFinalPage!: () => void;
  const finalPage = new Promise<void>((resolve) => { releaseFinalPage = resolve; });
  await page.route("**/api/movement-graph**", async (route) => {
    const url = new URL(route.request().url());
    const nodeOffset = Number(url.searchParams.get("nodeOffset") ?? 0);
    if (nodeOffset === 0) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          data: {
            ...movementGraph.data,
            counts: { nodes: 2, relationships: 1 },
            nodes: [movementGraph.data.nodes[0]],
            relationships: [movementGraph.data.relationships[0]],
            page: { nodeOffset: 0, relationshipOffset: 0, pageSize: 24, hasMoreNodes: true, hasMoreRelationships: false },
          },
        }),
      });
      return;
    }
    await finalPage;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        data: {
          ...movementGraph.data,
          counts: { nodes: 2, relationships: 1 },
          nodes: [movementGraph.data.nodes[1]],
          relationships: [],
          page: { nodeOffset: 1, relationshipOffset: 1, pageSize: 24, hasMoreNodes: false, hasMoreRelationships: false },
        },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByText("1 loaded of 2 total nodes", { exact: true })).toBeVisible();
  await expect(page.getByText("Branch controls stay unavailable until the revision-pinned projection finishes loading.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Active relationship map" })).toHaveCount(0);

  releaseFinalPage();
  await expect(page.getByRole("region", { name: "Movement knowledge graph complete graph" })).toContainText("Select a node to follow connections.");
});

test("retries unavailable and stale graph states without exposing stale branch content", async ({ page }) => {
  let graphRequests = 0;
  await page.route("**/api/movement-graph**", async (route) => {
    graphRequests += 1;
    const body = graphRequests === 1
      ? { status: "stale", domain: "movement-clinical", requestedRevisionId: "movement:old", activeRevisionId: "movement:coach-demo" }
      : movementGraph;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
  await page.getByRole("button", { name: "Show full graph" }).click();
  await expect(page.getByText("This graph revision is no longer active.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Active relationship map" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Movement knowledge graph complete graph" })).toContainText("Select a node to follow connections.");
  expect(graphRequests).toBe(2);
});

test("renders graph-derived markup as text in visual, semantic, status, and detail surfaces", async ({ page }) => {
  const unsafeGraph = {
    ...movementGraph,
    data: {
      ...movementGraph.data,
      counts: { nodes: 2, relationships: 1 },
      nodes: [
        { ...movementGraph.data.nodes[0], label: "<img src=x onerror=alert(1)>Squat" },
        { ...movementGraph.data.nodes[1], label: "<svg onload=alert(2)>Knee" },
      ],
      relationships: [{
        ...movementGraph.data.relationships[0],
        provenance: {
          ...movementGraph.data.relationships[0].provenance,
          source: { locator: "<script>alert(3)</script>", artifactDigest: "sha256:markup-demo" },
        },
      }],
    },
  };
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unsafeGraph) });
  });
  await openMovementGraph(page);

  const completeGraph = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
  await expect(completeGraph).toContainText("<img src=x onerror=alert(1)>Squat");
  await completeGraph.getByRole("button", { name: /^Start with <img src=x onerror=alert\(1\)>Squat/ }).click();
  const map = page.getByRole("region", { name: "Active relationship map" });
  await expect(map).toContainText("<svg onload=alert(2)>Knee");
  await expect(map.locator("img, script")).toHaveCount(0);
  await map.getByRole("button", { name: /^Inspect relationship:/ }).click();
  const technical = page.getByRole("region", { name: "Source and provenance details" }).locator("details");
  await technical.getByText("Technical reference", { exact: true }).click();
  await expect(technical).toContainText("<script>alert(3)</script>");
  await expect(technical.locator("script")).toHaveCount(0);
  await expect(page.evaluate(() => (globalThis as typeof globalThis & { __graphMarkupExecuted?: boolean }).__graphMarkupExecuted ?? false)).resolves.toBe(false);
});

test("discards a delayed member revision after switching to the Movement graph", async ({ page }) => {
  let releaseMemberResponse!: () => void;
  const memberResponse = new Promise<void>((resolve) => { releaseMemberResponse = resolve; });
  await page.route("**/api/member-context/graph**", async (route) => {
    await memberResponse;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memberGraph) }).catch(() => undefined);
  });
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(movementGraph) });
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
    await page.getByRole("button", { name: /Athlete profile/ }).click();
    await page.getByRole("button", { name: "Show full graph" }).click();
    await expect(page.getByText("Loading the first graph page…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "← Focused view" }).click();

    await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Coach" }).click();
    await page.getByRole("button", { name: "Show full graph" }).click();
    const movement = page.getByRole("region", { name: "Movement knowledge graph complete graph" });
    await expect(movement).toContainText("Select a node to follow connections.");

    releaseMemberResponse();
    await expect(movement).toContainText("Squat");
    await expect(movement).not.toContainText("Jordan Rivera");
    await expect(page.getByRole("region", { name: "Member context graph complete graph" })).toHaveCount(0);
  } finally {
    releaseMemberResponse();
  }
});

test("@a11y keeps native graph controls operable without overflow at supported widths", async ({ page }) => {
  await page.route("**/api/movement-graph**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(movementGraph) });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openMovementGraph(page);

  const root = page.getByRole("button", { name: /^Start with Squat/ });
  await root.focus();
  await page.keyboard.press("Enter");
  const knee = page.getByRole("button", { name: /^Follow Knee through targets/ });
  await knee.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Knee · Joint/ })).toBeFocused();
  await expect(page.getByRole("region", { name: "Active relationship map" }).locator("[role='tree'], [role='grid']")).toHaveCount(0);

  for (const width of [320, 430, 1440]) {
    await page.setViewportSize({ width, height: 932 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }

  const results = await new AxeBuilder({ page }).include('[aria-label="Movement knowledge graph"]').analyze();
  expect(results.violations).toEqual([]);
});
