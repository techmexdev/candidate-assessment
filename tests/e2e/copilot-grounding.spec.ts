import { expect, test, type Page, type Route } from "@playwright/test";

import type { CopilotRequest, SignedCopilotContinuation } from "../../src/domain/contracts/copilot";
import { createCopilotContinuationAuthority } from "../../src/server/copilot/continuation-token";

type RequestBody = CopilotRequest;

const COACH_ID = "coach:casey";
const REVISION_ONE = `member-context:sha256:${"1".repeat(64)}`;
const REVISION_TWO = `member-context:sha256:${"2".repeat(64)}`;
const CONTINUATION_NOW = "2026-08-07T10:05:00.000Z";
const continuationAuthority = createCopilotContinuationAuthority({
  secret: "e2e-copilot-continuation-secret-v1---------",
  now: () => CONTINUATION_NOW,
});

function continuationExpired(body: RequestBody) {
  return {
    status: "continuation-expired",
    requestId: body.requestId,
    message: "The saved Copilot context is no longer valid. Refresh deliberately to start from the active revision.",
    controls: { retry: false, refresh: true, keepLastReadyAnswer: true },
  };
}

async function rejectInvalidContinuation(route: Route, body: RequestBody): Promise<boolean> {
  if (!body.continuation) return false;
  const claims = await continuationAuthority.verify(body.continuation);
  if (claims?.coachId === COACH_ID && claims.memberId === body.memberId) return false;
  await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(continuationExpired(body)) });
  return true;
}

async function answer(body: RequestBody, answerId: string, revision = REVISION_ONE, options: { allZeroChart?: boolean; includeConversation?: boolean; richMorning?: boolean; limitationOnly?: boolean } = {}) {
  const evidenceId = `evidence:${answerId}`;
  const intentId = body.input.kind === "quick-prompt" ? body.input.promptId : "adherence";
  const scope = { memberId: body.memberId, contextRevisionId: revision, authority: "canonical" as const };
  const temporal = { precision: "date" as const, effectiveOn: "2026-06-04" };
  const source = { locator: "/synthetic/evidence", artifactDigest: `sha256:${"a".repeat(64)}` };
  const conversationEvidence = options.includeConversation ? [
    { ...scope, atomKind: "fact" as const, evidenceId: `${evidenceId}:message`, evidenceKind: "message" as const, source, classification: "source-statement" as const, temporal, unit: null, value: "Still no barbell at home btw — only DBs and a kettlebell." },
    { ...scope, atomKind: "media-metadata" as const, evidenceId: `${evidenceId}:media`, evidenceKind: "media-attachment" as const, source, classification: "source-statement" as const, temporal, unit: null, mediaType: "image/jpeg", caption: "Home setup photo (synthetic placeholder)", assetStatus: "metadata-only" as const, analysisStatus: "not-analyzed" as const },
  ] : [];
  const taskEvidence = intentId === "morning-brief" ? [
    { ...scope, atomKind: "fact" as const, evidenceId: `${evidenceId}:celebrate`, evidenceKind: "coach-task" as const, source, classification: "observation" as const, temporal, unit: null, value: "Celebrate the completed training streak." },
    { ...scope, atomKind: "fact" as const, evidenceId: `${evidenceId}:risk`, evidenceKind: "coach-task" as const, source, classification: "observation" as const, temporal, unit: null, value: "Review the missed session risk." },
  ] : [];
  const continuation = await continuationAuthority.sign({
    schemaVersion: "copilot-continuation-claims/v1",
    coachId: COACH_ID,
    memberId: body.memberId,
    contextRevisionId: revision,
    answerId,
    intentId,
    selectedEvidenceIds: [evidenceId, ...conversationEvidence.map((atom) => atom.evidenceId)],
    issuedAt: "2026-08-07T10:00:00.000Z",
    expiresAt: "2026-08-07T10:15:00.000Z",
  });
  return {
    status: "ready",
    requestId: body.requestId,
    controls: { retry: false, refresh: false, keepLastReadyAnswer: false },
    answer: {
      schemaVersion: "copilot-answer/v1",
      requestId: body.requestId,
      answerId,
      ...scope,
      intentId,
      requestedFor: body.requestedFor,
      evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
      memberTimezone: "America/Chicago",
      briefFreshness: intentId === "morning-brief" ? { status: "latest-recorded", generatedFor: "2026-06-04" } : null,
      evidence: { ...scope, atoms: [{ ...scope, atomKind: "fact", evidenceId, evidenceKind: "observation", source, classification: "observation", temporal, unit: "percent", value: 50 }, ...taskEvidence, ...conversationEvidence] },
      sections: options.limitationOnly ? [
        { sectionId: "limitation", clauses: [{ clauseId: `limitation:${answerId}`, text: "Insufficient recorded history for a complete morning brief.", evidenceIds: [evidenceId] }] },
      ] : [
        { sectionId: "answer", clauses: intentId === "churn-risk" ? [
          { clauseId: `clause:${answerId}:completion-one`, text: "weekly-workout-completion: 100 percent.", evidenceIds: [evidenceId] },
          { clauseId: `clause:${answerId}:completion-two`, text: "weekly-workout-completion: 50 percent.", evidenceIds: [evidenceId] },
          { clauseId: `clause:${answerId}:message`, text: "Member message: Skipped Thursday because work was exhausting.", evidenceIds: [evidenceId] },
          { clauseId: `clause:${answerId}:unsupported`, text: "A source-provided risk reason is excluded because its basis is unsupported.", evidenceIds: [evidenceId] },
        ] : [{ clauseId: `clause:${answerId}`, text: `${intentId} grounded answer ${answerId}.`, evidenceIds: [evidenceId] }] },
        { sectionId: "next-action", clauses: [{ clauseId: `action:${answerId}`, text: "Review the supported evidence with the member.", evidenceIds: [evidenceId] }] },
        ...(options.richMorning ? [
          { sectionId: "recent-facts", clauses: [{ clauseId: `fact:${answerId}`, text: "Weekly completion reached 67 percent.", evidenceIds: [evidenceId] }] },
          { sectionId: "trend", clauses: [{ clauseId: `trend:${answerId}`, text: "Adherence is steady across recent weeks.", evidenceIds: [evidenceId] }] },
        ] : []),
      ],
      tasks: taskEvidence.length === 2 ? [
        { taskId: `${evidenceId}:task:celebrate`, taskType: "celebrate" as const, actionId: "celebrate-progress" as const, text: String(taskEvidence[0].value), evidenceIds: [taskEvidence[0].evidenceId], sourceOrder: 0 },
        { taskId: `${evidenceId}:task:risk`, taskType: "review_risk" as const, actionId: "review-churn-risk" as const, text: String(taskEvidence[1].value), evidenceIds: [taskEvidence[1].evidenceId], sourceOrder: 1 },
      ] : [],
      chart: !options.limitationOnly && (intentId === "sleep" || intentId === "adherence" || options.richMorning) ? {
        ...scope,
        chartId: `chart:${answerId}`,
        recipeId: "deterministic-test",
        type: "bar",
        unit: "percent",
        precision: "date",
        temporalMode: "calendar",
        points: options.allZeroChart
          ? [
              { pointId: `point:${answerId}:1`, label: "May 28", value: 0, evidenceIds: [evidenceId] },
              { pointId: `point:${answerId}:2`, label: "Jun 4", value: 0, evidenceIds: [evidenceId] },
            ]
          : [{ pointId: `point:${answerId}`, label: "Jun 4", value: 50, evidenceIds: [evidenceId] }],
        textSummary: options.allZeroChart ? "May 28: 0 percent. Jun 4: 0 percent." : "Jun 4: 50 percent.",
      } : null,
      citations: options.limitationOnly ? [] : [
        { ...scope, citationId: `citation:${answerId}`, evidenceId, label: "Synthetic source", source, classification: "observation", temporal, unit: "percent" },
        ...conversationEvidence.map((atom) => ({ ...scope, citationId: `citation:${atom.evidenceId}`, evidenceId: atom.evidenceId, label: atom.evidenceKind === "message" ? "Member check-in" : "Home setup photo", source, classification: "source-statement" as const, temporal, unit: null })),
        ...taskEvidence.map((task) => ({ ...scope, citationId: `citation:${task.evidenceId}`, evidenceId: task.evidenceId, label: "Synthetic coach task", source, classification: "observation" as const, temporal, unit: null })),
      ],
      churn: !options.limitationOnly && (intentId === "morning-brief" || intentId === "churn-risk") ? {
        derived: {
          ...scope,
          methodVersion: "churn-v1",
          level: "watch",
          reasons: [{ code: "planned-workout-missed-1", evidenceIds: [evidenceId] }],
          excludedSourceReasons: [{ code: "unsupported-source-risk", basisStatus: "unsupported-source", evidenceIds: [evidenceId] }],
          evidenceIds: [evidenceId],
        },
        source: {
          ...scope,
          level: "high",
          reasons: [
            { text: "Coach-entered cancellation concern.", basisStatus: "supported", evidenceIds: [evidenceId] },
            { text: "Inferred login frequency decline.", basisStatus: "unsupported-source", evidenceIds: [evidenceId] },
          ],
          evidenceIds: [evidenceId],
        },
      } : null,
      continuation,
    },
  };
}

async function installReadyRoute(page: Page, seen: RequestBody[]) {
  await page.route("**/api/copilot", async (route: Route) => {
    const body = route.request().postDataJSON() as RequestBody;
    seen.push(body);
    if (await rejectInvalidContinuation(route, body)) return;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, `answer:${seen.length}`, REVISION_ONE, {
      includeConversation: body.input.kind === "quick-prompt" && body.input.promptId === "morning-brief",
      richMorning: body.input.kind === "quick-prompt" && body.input.promptId === "morning-brief",
    })) });
  });
}

test("Today morning brief is concise by default and complete on demand", async ({ page }) => {
  const seen: RequestBody[] = [];
  await installReadyRoute(page, seen);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();

  const brief = page.locator('[data-answer-id="answer:1"]');
  await expect(brief).toHaveAttribute("data-copilot-presentation", "workbench");
  await expect(brief.getByText(/Latest recorded.*June 4/)).toBeVisible();
  await expect(brief.getByText("Celebrate the completed training streak.")).toBeVisible();
  await expect(brief.getByText("morning-brief grounded answer answer:1.")).toBeHidden();
  await expect(brief.getByText("Watch", { exact: true })).toBeVisible();
  await expect(brief.getByText("Review the supported evidence with the member.")).toBeVisible();

  const disclosures = {
    analysis: brief.getByTestId("copilot-disclosure-analysis"),
    facts: brief.getByTestId("copilot-disclosure-facts"),
    trend: brief.getByTestId("copilot-disclosure-trend"),
    risk: brief.getByTestId("copilot-disclosure-risk"),
    sources: brief.getByTestId("copilot-disclosure-sources"),
  };
  for (const disclosure of Object.values(disclosures)) await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(brief.getByText("Weekly completion reached 67 percent.")).toBeHidden();
  await expect(brief.getByText("Adherence is steady across recent weeks.")).toBeHidden();
  await expect(brief.getByText("planned-workout-missed-1")).toBeHidden();
  await expect(brief.getByText(`REVISION · ${REVISION_ONE}`, { exact: false })).toBeHidden();

  const requestCountBeforeDisclosure = seen.length;
  for (const disclosure of Object.values(disclosures)) await disclosure.locator("summary").click();
  await expect(disclosures.analysis.getByText("morning-brief grounded answer answer:1.")).toBeVisible();
  await expect(disclosures.analysis.getByText("Review the missed session risk.")).toBeVisible();
  await expect(disclosures.facts.getByText("Weekly completion reached 67 percent.")).toBeVisible();
  await expect(disclosures.trend.getByText("Adherence is steady across recent weeks.")).toBeVisible();
  await expect(disclosures.trend.getByRole("img", { name: "Jun 4: 50 percent." })).toBeVisible();
  await expect(disclosures.risk.getByText("METHOD · churn-v1")).toBeVisible();
  await expect(disclosures.risk.getByText("Coach-entered cancellation concern.")).toBeVisible();
  await expect(disclosures.sources.getByText(`REVISION · ${REVISION_ONE}`, { exact: false })).toBeVisible();
  await expect(brief.getByRole("button", { name: /Inspect context/ })).toHaveCount(0);
  expect(seen).toHaveLength(requestCountBeforeDisclosure);

  await page.getByRole("button", { name: /Copilot context/ }).click();
  const workbench = page.locator('[data-answer-id="answer:1"]');
  await workbench.getByTestId("copilot-disclosure-sources").locator("summary").click();
  await expect(workbench.getByRole("button", { name: /Member check-in.*Inspect context/ })).toBeVisible();
});

test("Today omits empty morning brief disclosures for a limitation-only packet", async ({ page }) => {
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, "answer:limited", REVISION_ONE, { limitationOnly: true })) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();

  const brief = page.locator('[data-answer-id="answer:limited"]');
  await expect(brief.getByText("Insufficient recorded history for a complete morning brief.")).toBeVisible();
  await expect(brief.getByTestId("copilot-disclosure-facts")).toHaveCount(0);
  await expect(brief.getByTestId("copilot-disclosure-trend")).toHaveCount(0);
  await expect(brief.getByTestId("copilot-disclosure-risk")).toHaveCount(0);
  await expect(brief.getByTestId("copilot-disclosure-additional")).toHaveCount(0);
  await expect(brief.getByTestId("copilot-disclosure-sources")).not.toHaveAttribute("open", "");
});

test("Today retains a ready morning brief while an update fails and allows retry", async ({ page }) => {
  let count = 0;
  let releaseUpdate: (() => void) | undefined;
  let signalUpdate: (() => void) | undefined;
  const updateStarted = new Promise<void>((resolve) => { signalUpdate = resolve; });
  const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    count += 1;
    if (count === 2) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          status: "model-error",
          requestId: body.requestId,
          code: "provider-unavailable",
          retryable: true,
          message: "Copilot model is temporarily unavailable.",
          controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
        }),
      });
      return;
    }
    if (count === 3) {
      signalUpdate?.();
      await updateReleased;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, count === 1 ? "answer:ready" : "answer:retried", REVISION_ONE, { richMorning: true })) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expect(page.locator('[data-answer-id="answer:ready"]')).toBeVisible();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Morning brief", exact: true }).click();
  await expect(page.getByText("Copilot model unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();

  const retained = page.locator('[data-answer-id="answer:ready"]');
  await expect(retained).toBeVisible();
  await expect(retained.getByText(/Latest recorded.*June 4/)).toBeVisible();
  await expect(page.getByText("Copilot model unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry morning brief", exact: true }).click();
  await updateStarted;
  await expect(page.getByRole("status").filter({ hasText: "Updating morning brief…" })).toBeVisible();
  await expect(retained).toBeVisible();
  releaseUpdate?.();
  await expect(page.locator('[data-answer-id="answer:retried"]')).toBeVisible();
  expect(count).toBe(3);
});

test("brief, prompts, free text and follow-up use route packets and one pinned revision", async ({ page }) => {
  const seen: RequestBody[] = [];
  await installReadyRoute(page, seen);
  await page.goto("/");
  await page.waitForTimeout(200);
  await expect(page.getByText(/fixture demo/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expect(page.getByText(/Latest recorded.*June 4/)).toBeVisible();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const morningBrief = page.locator('[data-answer-id="answer:1"]');
  await expect(morningBrief.getByText("Celebrate the completed training streak.")).toBeVisible();
  await expect(morningBrief.getByText("grounded answer answer:1")).toBeHidden();
  const morningTasks = page.getByTestId("copilot-disclosure-morning-tasks");
  await expect(morningTasks).not.toHaveAttribute("open", "");
  await expect(morningTasks.getByRole("button", { name: "Open grounded context" }).first()).toBeHidden();
  await morningTasks.locator(":scope > summary").click();
  await expect(morningTasks.getByRole("button", { name: "Open grounded context" })).toHaveCount(2);
  const morningRisk = morningBrief.getByTestId("copilot-disclosure-risk");
  await expect(morningRisk).not.toHaveAttribute("open", "");
  await expect(morningRisk.getByText("planned-workout-missed-1")).toBeHidden();
  await morningRisk.locator("summary").click();
  await expect(morningRisk.getByText("METHOD · churn-v1")).toBeVisible();
  await expect(morningRisk.getByText("planned-workout-missed-1")).toBeVisible();
  await expect(morningRisk.getByText("Coach-entered cancellation concern.")).toBeVisible();
  await expect(morningRisk.getByText("Inferred login frequency decline.")).toBeVisible();
  await expect(morningRisk.getByText("unsupported-source-risk")).toBeVisible();

  for (const [label, promptId] of [
    ["Adherence", "adherence"],
    ["Sleep", "sleep"],
    ["What changed since last week?", "changes-since-last-week"],
    ["Churn risk", "churn-risk"],
  ] as const) {
    const requestIndex = seen.length;
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => seen.length).toBe(requestIndex + 1);
    const request = seen[requestIndex];
    expect(request).toMatchObject({
      schemaVersion: "copilot-request/v1",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "quick-prompt", promptId },
    });
    expect(request.continuation?.claims).toMatchObject({
      coachId: COACH_ID,
      memberId: request.memberId,
      contextRevisionId: REVISION_ONE,
      answerId: `answer:${requestIndex}`,
    });
    const currentAnswer = page.locator(`[data-answer-id="answer:${requestIndex + 1}"]`);
    await expect(currentAnswer).toBeVisible();
    await expect(currentAnswer.getByText("Review the supported evidence with the member.")).toBeVisible();
  }

  const churnRisk = page.locator('[data-answer-id="answer:5"]');
  await expect(churnRisk.getByLabel("Why").getByText("Coach-entered cancellation concern.")).toBeVisible();
  await expect(churnRisk.getByText("weekly-workout-completion: 100 percent.")).toBeHidden();
  await expect(churnRisk.getByText("Member message: Skipped Thursday because work was exhausting.")).toBeHidden();
  await expect(churnRisk.getByText("A source-provided risk reason is excluded because its basis is unsupported.")).toBeHidden();
  const fullAnalysis = churnRisk.getByTestId("copilot-disclosure-analysis");
  await expect(fullAnalysis).not.toHaveAttribute("open", "");
  const requestCountBeforeAnalysis = seen.length;
  await fullAnalysis.locator("summary").click();
  await expect(fullAnalysis.getByText("weekly-workout-completion: 100 percent.")).toBeVisible();
  await expect(fullAnalysis.getByText("Member message: Skipped Thursday because work was exhausting.")).toBeVisible();
  await expect(fullAnalysis.getByText("A source-provided risk reason is excluded because its basis is unsupported.")).toBeVisible();
  expect(seen).toHaveLength(requestCountBeforeAnalysis);
  const churnRiskDisclosure = churnRisk.getByTestId("copilot-disclosure-risk");
  await churnRiskDisclosure.locator("summary").click();
  await expect(churnRiskDisclosure).toContainText("Level · watch");
  await expect(churnRiskDisclosure).toContainText("Level · high");
  await expect(churnRiskDisclosure).toContainText("not used in the derived assessment");

  const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
  await input.fill("How should I follow up?");
  const followUpIndex = seen.length;
  await page.getByRole("button", { name: "Ask Copilot" }).click();
  await expect.poll(() => seen.length).toBe(followUpIndex + 1);
  expect(seen[followUpIndex]).toMatchObject({
    schemaVersion: "copilot-request/v1",
    memberId: "mbr_01HX9JORDAN",
    requestedFor: "2026-07-08",
    input: { kind: "free-text", question: "How should I follow up?" },
    continuation: { claims: { contextRevisionId: REVISION_ONE, answerId: "answer:5", intentId: "churn-risk" } },
  });
  const requestIds = new Set(seen.map(({ requestId }) => requestId));
  expect(requestIds.size).toBe(seen.length);

  const latestAnswer = page.locator('[data-answer-id="answer:6"]');
  await latestAnswer.getByTestId("copilot-disclosure-trend").locator("summary").click();
  const chart = latestAnswer.getByRole("img", { name: "Jun 4: 50 percent." });
  await expect(chart).toBeVisible();
  await expect(chart.locator("xpath=..")).toContainText("Jun 4: 50 percent.");
});

test("a cited conversation anchor opens revision-pinned secondary context and returns to Copilot", async ({ page }) => {
  const seen: RequestBody[] = [];
  const conversationUrls: string[] = [];
  await installReadyRoute(page, seen);
  await page.route("**/api/member-context/conversation*", async (route: Route) => {
    const url = new URL(route.request().url());
    conversationUrls.push(url.toString());
    const anchorEvidenceId = url.searchParams.get("anchorEvidenceId");
    const mediaEvidenceId = anchorEvidenceId?.replace(/:message$/, ":media");
    expect(anchorEvidenceId).toBe("evidence:answer:1:message");
    expect(url.searchParams.get("contextRevisionId")).toBe(REVISION_ONE);
    expect(url.searchParams.get("answerId")).toBe("answer:1");
    expect(url.searchParams.get("evidenceAsOf")).toBe("2026-06-04T23:59:59.999-05:00");
    expect(url.searchParams.get("memberTimezone")).toBe("America/Chicago");
    expect(JSON.parse(url.searchParams.get("continuation") ?? "null")).toMatchObject({ claims: { answerId: "answer:1", selectedEvidenceIds: expect.arrayContaining([anchorEvidenceId]) } });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        timeline: {
          memberId: "mbr_01HX9JORDAN",
          contextRevisionId: REVISION_ONE,
          authority: "canonical",
          conversationEvidenceId: "conversation:answer:1",
          anchorEvidenceId,
          evidenceAsOf: url.searchParams.get("evidenceAsOf"),
          memberTimezone: url.searchParams.get("memberTimezone"),
          window: {
            fromInclusive: url.searchParams.get("from"),
            toExclusive: url.searchParams.get("to"),
          },
          messages: [{
            evidenceId: anchorEvidenceId,
            semanticId: "message:home-setup",
            assertionId: "assertion:message:home-setup",
            kind: "message",
            source: { locator: "/synthetic/member-context", artifactDigest: `sha256:${"b".repeat(64)}` },
            classification: "source-statement",
            temporal: { precision: "date", effectiveOn: "2026-05-22" },
            senderRole: "member",
            text: "Still no barbell at home btw — only DBs and a kettlebell.",
            attachmentEvidenceIds: mediaEvidenceId ? [mediaEvidenceId] : [],
            attachments: mediaEvidenceId ? [{
              evidenceId: mediaEvidenceId,
              semanticId: "media:home-setup",
              assertionId: "assertion:media:home-setup",
              kind: "media-attachment",
              source: { locator: "/synthetic/member-context", artifactDigest: `sha256:${"b".repeat(64)}` },
              classification: "source-statement",
              temporal: { precision: "date", effectiveOn: "2026-05-22" },
              mediaType: "image/jpeg",
              caption: "Home setup photo (synthetic placeholder)",
              sourceOrder: 0,
              assetStatus: "metadata-only",
              analysisStatus: "not-analyzed",
              asset: { status: "available", path: "/synthetic/jordan-home-equipment.svg" },
            }] : [],
          }],
        },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const citation = page.getByRole("button", { name: /Member check-in.*Inspect context/ });
  await page.getByTestId("copilot-disclosure-sources").locator("summary").click();
  await expect(citation).toBeVisible();
  await citation.click();

  await expect(page.getByTestId("supporting-context-summary")).toContainText("REVISION-PINNED");
  await expect(page.getByText("Still no barbell at home btw — only DBs and a kettlebell.")).toBeVisible();
  await expect(page.getByText(/SYNTHETIC ASSET · NOT ANALYZED/)).toBeVisible();
  await expect(page.locator('[data-context-anchor="true"]')).toHaveCount(1);
  expect(conversationUrls).toHaveLength(1);
  expect(seen).toHaveLength(1);

  await page.getByRole("button", { name: "Go back" }).click();
  await page.getByTestId("copilot-disclosure-sources").locator("summary").click();
  await expect(page.getByRole("button", { name: /Member check-in.*Inspect context/ })).toBeVisible();
});

test("all-zero chart packets render every bar at zero height", async ({ page }) => {
  let count = 0;
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    count += 1;
    if (await rejectInvalidContinuation(route, body)) return;
    const allZeroChart = body.input.kind === "quick-prompt" && body.input.promptId === "adherence";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, `answer:${count}`, REVISION_ONE, { allZeroChart })) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Adherence", exact: true }).click();

  const answerCard = page.locator('[data-copilot-presentation="workbench"]');
  await answerCard.getByTestId("copilot-disclosure-trend").locator("summary").click();
  const chart = answerCard.getByRole("img", { name: "May 28: 0 percent. Jun 4: 0 percent." });
  await expect(chart).toBeVisible();
  const zeroBars = chart.locator('[data-chart-value="0"]');
  await expect(zeroBars).toHaveCount(2);
  await expect.poll(() => zeroBars.evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).height))).toEqual(["0px", "0px"]);
});

test("risk action stays disabled while the automatic morning brief is pending", async ({ page }) => {
  let releaseRequest: (() => void) | undefined;
  let signalRequest: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
  const requestReleased = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    signalRequest?.();
    await requestReleased;
    if (await rejectInvalidContinuation(route, body)) return;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, "answer:pending")) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await requestStarted;

  const riskAction = page.getByRole("button", { name: "Ask Copilot about risk" });
  await expect(riskAction).toBeDisabled();
  await expect(page.getByText("Loading morning brief…")).toBeVisible();
  releaseRequest?.();
  await expect(riskAction).toBeEnabled();
});

test("every canonical roster member reaches graph Copilot without fixture fallback", async ({ page }) => {
  const seen: RequestBody[] = [];
  await installReadyRoute(page, seen);
  await page.goto("/");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open Avery Chen morning brief", exact: true }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toMatchObject({
    schemaVersion: "copilot-request/v1",
    memberId: "mbr_02HX9AVERY",
    requestedFor: "2026-07-08",
    input: { kind: "quick-prompt", promptId: "morning-brief" },
  });
  await expect(page.locator('[data-answer-id="answer:1"]')).toBeVisible();
  await expect(page.locator('[data-answer-id="answer:1"]').getByLabel("Priority").getByText("Celebrate the completed training streak.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Morning brief", exact: true })).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Member context unavailable" })).toHaveCount(0);
});

test("typed failure controls preserve the ready answer and expose only allowed retry", async ({ page }) => {
  let count = 0;
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    count += 1;
    if (await rejectInvalidContinuation(route, body)) return;
    const payload = count === 1 ? await answer(body, "answer:ready") : {
      status: "model-error",
      requestId: body.requestId,
      code: "provider-unavailable",
      retryable: true,
      message: "Copilot model is temporarily unavailable.",
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    };
    await route.fulfill({ status: count === 1 ? 200 : 503, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  await expect(page.getByText("Copilot model unavailable", { exact: true })).toBeVisible();
  await expect(page.locator('[data-answer-id="answer:ready"]')).toBeVisible();
  await expect(page.locator('[data-answer-id="answer:ready"]').getByLabel("Priority").getByText("Celebrate the completed training streak.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh active revision/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.locator('[data-answer-id="answer:ready"]')).toBeVisible();
  await expect(page.getByText("Copilot model unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry morning brief", exact: true })).toHaveCount(0);
});

test("expired continuation preserves the answer and refreshes the same request without the dead token", async ({ page }) => {
  const seen: RequestBody[] = [];
  await page.route("**/api/copilot", async (route) => {
    const body = route.request().postDataJSON() as RequestBody;
    seen.push(body);
    const requestNumber = seen.length;
    if (requestNumber === 2) {
      const claims = body.continuation ? await continuationAuthority.verify(body.continuation) : null;
      expect(claims).toMatchObject({ coachId: COACH_ID, memberId: body.memberId, contextRevisionId: REVISION_ONE, answerId: "answer:ready" });
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(continuationExpired(body)) });
      return;
    }
    if (await rejectInvalidContinuation(route, body)) return;
    const payload = requestNumber === 1
      ? await answer(body, "answer:ready")
      : await answer(body, requestNumber === 3 ? "answer:refreshed" : `answer:${requestNumber}`, REVISION_TWO);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  await page.getByRole("button", { name: "Sleep", exact: true }).click();

  await expect(page.getByText("Continuation expired", { exact: true })).toBeVisible();
  await expect(page.locator('[data-answer-id="answer:ready"]')).toBeVisible();
  await expect(page.locator('[data-answer-id="answer:ready"]').getByLabel("Priority").getByText("Celebrate the completed training streak.")).toBeVisible();
  const refresh = page.getByRole("button", { name: "Refresh active revision" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect.poll(() => seen.length).toBe(3);

  expect(seen[2]).toMatchObject({
    schemaVersion: "copilot-request/v1",
    memberId: seen[1].memberId,
    requestedFor: seen[1].requestedFor,
    input: seen[1].input,
  });
  expect(seen[2].requestId).not.toBe(seen[1].requestId);
  expect(seen[2]).not.toHaveProperty("continuation");
  await expect(page.locator('[data-answer-id="answer:refreshed"]')).toHaveAttribute("data-revision-id", REVISION_TWO);
  await expect(page.locator('[data-answer-id="answer:refreshed"]')).toBeVisible();
  const previousResults = page.getByTestId("copilot-disclosure-previous-results");
  await expect(previousResults).not.toHaveAttribute("open", "");
  await previousResults.locator(":scope > summary").click();
  await expect(previousResults.locator('[data-answer-id="answer:ready"]').getByText("Celebrate the completed training streak.")).toBeVisible();
  await expect(refresh).toHaveCount(0);

  const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
  await input.fill("What changed?");
  await page.getByRole("button", { name: "Ask Copilot" }).click();
  await expect.poll(() => seen.length).toBe(4);
  expect((seen[3].continuation as SignedCopilotContinuation | undefined)?.claims).toMatchObject({
    memberId: seen[2].memberId,
    contextRevisionId: REVISION_TWO,
    answerId: "answer:refreshed",
    intentId: "sleep",
  });
});
