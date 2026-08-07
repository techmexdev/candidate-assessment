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

async function answer(body: RequestBody, answerId: string, revision = REVISION_ONE, options: { allZeroChart?: boolean } = {}) {
  const evidenceId = `evidence:${answerId}`;
  const intentId = body.input.kind === "quick-prompt" ? body.input.promptId : "adherence";
  const scope = { memberId: body.memberId, contextRevisionId: revision, authority: "canonical" as const };
  const temporal = { precision: "date" as const, effectiveOn: "2026-06-04" };
  const source = { locator: "/synthetic/evidence", artifactDigest: `sha256:${"a".repeat(64)}` };
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
    selectedEvidenceIds: [evidenceId],
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
      evidence: { ...scope, atoms: [{ ...scope, atomKind: "fact", evidenceId, evidenceKind: "observation", source, classification: "observation", temporal, unit: "percent", value: 50 }, ...taskEvidence] },
      sections: [
        { sectionId: "answer", clauses: [{ clauseId: `clause:${answerId}`, text: `${intentId} grounded answer ${answerId}.`, evidenceIds: [evidenceId] }] },
        { sectionId: "next-action", clauses: [{ clauseId: `action:${answerId}`, text: "Review the supported evidence with the member.", evidenceIds: [evidenceId] }] },
      ],
      tasks: taskEvidence.length === 2 ? [
        { taskId: `${evidenceId}:task:celebrate`, taskType: "celebrate" as const, actionId: "celebrate-progress" as const, text: String(taskEvidence[0].value), evidenceIds: [taskEvidence[0].evidenceId], sourceOrder: 0 },
        { taskId: `${evidenceId}:task:risk`, taskType: "review_risk" as const, actionId: "review-churn-risk" as const, text: String(taskEvidence[1].value), evidenceIds: [taskEvidence[1].evidenceId], sourceOrder: 1 },
      ] : [],
      chart: intentId === "sleep" || intentId === "adherence" ? {
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
      citations: [
        { ...scope, citationId: `citation:${answerId}`, evidenceId, label: "Synthetic source", source, classification: "observation", temporal, unit: "percent" },
        ...taskEvidence.map((task) => ({ ...scope, citationId: `citation:${task.evidenceId}`, evidenceId: task.evidenceId, label: "Synthetic coach task", source, classification: "observation" as const, temporal, unit: null })),
      ],
      churn: intentId === "morning-brief" || intentId === "churn-risk" ? {
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(await answer(body, `answer:${seen.length}`)) });
  });
}

test("brief, prompts, free text and follow-up use route packets and one pinned revision", async ({ page }) => {
  const seen: RequestBody[] = [];
  await installReadyRoute(page, seen);
  await page.goto("/");
  await page.waitForTimeout(200);
  await expect(page.getByText(/fixture demo/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await expect(page.getByText(/Latest recorded.*June 4/)).toBeVisible();
  const morningBrief = page.locator('[data-answer-id="answer:1"]');
  await expect(morningBrief.getByRole("region", { name: "Deterministic derived churn" })).toContainText("METHOD · churn-v1");
  await expect(morningBrief.getByRole("region", { name: "Deterministic derived churn" })).toContainText("planned-workout-missed-1");
  await expect(morningBrief.getByRole("region", { name: "Deterministic derived churn" })).toContainText("Evidence · Synthetic source");
  await expect(morningBrief.getByRole("region", { name: "Source-provided churn assessment" })).toContainText("Coach-entered cancellation concern.");
  await expect(morningBrief.getByRole("region", { name: "Source-provided churn assessment" })).toContainText("Inferred login frequency decline.");
  await expect(morningBrief.getByRole("region", { name: "Excluded unsupported-source churn reasons" })).toContainText("unsupported-source-risk");
  await page.getByRole("button", { name: /Copilot context/ }).click();

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
    await expect(page.getByText(new RegExp(`grounded answer answer:${requestIndex + 1}`))).toBeVisible();
  }

  const churnRisk = page.locator('[data-answer-id="answer:5"]');
  await expect(churnRisk.getByRole("region", { name: "Deterministic derived churn" })).toContainText("Level · watch");
  await expect(churnRisk.getByRole("region", { name: "Source-provided churn assessment" })).toContainText("Level · high");
  await expect(churnRisk.getByRole("region", { name: "Excluded unsupported-source churn reasons" })).toContainText("not used in the derived assessment");

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

  const chart = page.getByRole("img", { name: "Jun 4: 50 percent." }).first();
  await expect(chart).toBeVisible();
  await expect(chart.locator("xpath=..")).toContainText("Jun 4: 50 percent.");
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

  const chart = page.getByRole("img", { name: "May 28: 0 percent. Jun 4: 0 percent." });
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

test("other athletes and voice fail truthfully without fixture answers", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/copilot", async (route) => { requests += 1; await route.abort(); });
  await page.goto("/");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open Avery Chen morning brief", exact: true }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Member context unavailable" })).toBeVisible();
  await page.getByRole("button", { name: /Talk through today/ }).click();
  await expect(page.getByText("Continue in text Copilot")).toBeVisible();
  await expect(page.getByText(/Voice capture is disabled/i)).toBeVisible();
  expect(requests).toBe(0);
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
  await expect(page.getByText(/grounded answer answer:ready/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh active revision/ })).toHaveCount(0);
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
  await expect(page.getByText(/grounded answer answer:ready/)).toBeVisible();
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
  await expect(page.getByText(/grounded answer answer:ready/)).toBeVisible();
  await expect(page.getByText(/grounded answer answer:refreshed/)).toBeVisible();
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
