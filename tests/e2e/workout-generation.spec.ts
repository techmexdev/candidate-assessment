import { expect, test, type Page } from "@playwright/test";

const completedResource = {
  runId: "run:dashboard",
  state: "completed",
  requestedDurationMinutes: 45,
  movementGraphRevisionId: "movement:7",
  memberContextRevisionId: "member:4",
  workout: {
    workoutVersionId: "workout:dashboard",
    version: 1,
    createdAt: "2026-08-07T12:00:02.000Z",
    workout: {
      schemaVersion: "reviewable-workout/v1",
      runId: "run:dashboard",
      movementGraphRevisionId: "movement:7",
      memberContextRevisionId: "member:4",
      durationPolicyVersion: "duration:v1",
      sections: [
        { kind: "warm-up", items: [{ exerciseConceptId: "exercise:bike", dose: { kind: "timed", sets: 1, workSecondsPerSet: 300 }, restSeconds: 30, rationale: "Raises temperature without loading the knee.", timing: { plannedWorkSeconds: 300, plannedRestSeconds: 30, transitionSeconds: 15, totalSeconds: 345 }, warnings: [] }], timing: { plannedWorkSeconds: 300, plannedRestSeconds: 30, transitionSeconds: 15, totalSeconds: 345 } },
        { kind: "main", items: [{ exerciseConceptId: "exercise:box-squat", dose: { kind: "repetitions", sets: 3, repetitionsPerSet: 8, secondsPerRepetition: 4 }, restSeconds: 75, rationale: "Uses the reviewed knee-aware range.", timing: { plannedWorkSeconds: 96, plannedRestSeconds: 150, transitionSeconds: 15, totalSeconds: 261 }, warnings: [] }], timing: { plannedWorkSeconds: 96, plannedRestSeconds: 150, transitionSeconds: 15, totalSeconds: 261 } },
        { kind: "cool-down", items: [{ exerciseConceptId: "exercise:breathing", dose: { kind: "timed", sets: 1, workSecondsPerSet: 180 }, restSeconds: 0, rationale: "Closes the session at low intensity.", timing: { plannedWorkSeconds: 180, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 180 }, warnings: [] }], timing: { plannedWorkSeconds: 180, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 180 } },
      ],
      timing: { requestedDurationSeconds: 2700, plannedWorkSeconds: 576, plannedRestSeconds: 180, transitionSeconds: 30, totalSeconds: 786, differenceSeconds: -1914 },
    },
  },
  provenance: {
    traceSchemaVersion: "workout-provenance/v1",
    digest: "trace:digest",
    movementGraphRevisionId: "movement:7",
    memberContextRevisionId: "member:4",
    activity: { activityId: "run:dashboard", kind: "workout-generation" },
    entities: [],
    decisions: [
      { decisionId: "decision:box", kind: "selected", exerciseConceptId: "exercise:box-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:box"], contributingPathIds: ["path:knee"], evidenceIds: ["evidence:member"], explanation: "Selected through the reviewed knee-safe path." },
      { decisionId: "decision:split", kind: "excluded", exerciseConceptId: "exercise:split-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:split"], contributingPathIds: ["path:injured-joint"], evidenceIds: ["evidence:member"], explanation: "Excluded because the path reaches the injured knee." },
    ],
    relations: [],
  },
};

async function mockCompletedRuntime(page: Page) {
  await page.route("**/api/workout-runs", async (route) => {
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runId: "run:dashboard", status: "created" }) });
  });
  await page.route("**/api/workout-runs/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/events")) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          "id: cursor:1",
          "event: stage",
          `data: ${JSON.stringify({ eventId: "event:1", runId: "run:dashboard", sequence: 1, occurredAt: "2026-08-07T12:00:01.000Z", stage: "compose" })}`,
          "",
          "id: cursor:2",
          "event: completed",
          `data: ${JSON.stringify({ eventId: "event:2", runId: "run:dashboard", sequence: 2, occurredAt: "2026-08-07T12:00:02.000Z", workoutVersionId: "workout:dashboard" })}`,
          "",
        ].join("\n"),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completedResource) });
  });
}

test("projects the authoritative workout and stored trace after bounded progress", async ({ page }) => {
  await mockCompletedRuntime(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Review & approve/ }).click();

  await page.getByRole("textbox", { name: "Workout request" }).fill("Build a knee-aware strength workout");
  await page.getByRole("slider", { name: "Generated workout duration" }).fill("45");
  await page.getByRole("button", { name: "Generate workout" }).click();

  await expect(page.getByRole("heading", { name: "45-min Generated workout" })).toBeVisible();
  await expect(page.getByText("Warm-up", { exact: true })).toBeVisible();
  await expect(page.getByText("Main", { exact: true })).toBeVisible();
  await expect(page.getByText("Cool-down", { exact: true })).toBeVisible();
  await expect(page.getByText("3×8 · 75 sec rest", { exact: true })).toBeVisible();
  await expect(page.getByText("exercise:split-squat", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Decision path" }).last().click();
  await expect(page.getByText("path:injured-joint", { exact: true })).toBeVisible();
  await expect(page.getByText("movement:7 · member:4", { exact: true })).toBeVisible();
});
