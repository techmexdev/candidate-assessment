import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as currentSession, POST as signIn } from "../../src/app/api/session/route";
import { POST as submitWorkout } from "../../src/app/api/workout-runs/route";
import { POST as answerClarification } from "../../src/app/api/workout-runs/[runId]/clarification/route";
import { GET as readWorkout } from "../../src/app/api/workout-runs/[runId]/route";
import { createNeo4jClient } from "../../src/graph/neo4j/client";
import { createNeo4jMovementGraphReadProvider } from "../../src/graph/repositories/neo4j-movement-graph";
import {
  createConfiguredWorkoutServerInfrastructure,
  configuredWorkoutRouteComposition,
} from "../../src/server/workout-route-composition";
import { createConfiguredWorkoutWorkerComposition } from "../../src/server/workout-worker-composition";
import { runWorkoutWorkerPoll } from "../../src/server/workout-worker-poll";
import type { WorkoutProvenanceBundle } from "../../src/domain/contracts/workout-provenance";
import {
  assertConnectedAcceptanceCapture,
  type ConnectedAcceptanceCapture,
  type ConnectedDecisionCapture,
  type ConnectedSubstitutionCapture,
  type ConnectedScenarioCapture,
} from "../../src/domain/contracts/connected-acceptance";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";

const enabled = process.env.CONNECTED_ACCEPTANCE === "1";
const memberId = "mbr_01HX9JORDAN";
const origin = "http://localhost";

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("[ASSERTION] Sign-in did not issue a session cookie.");
  return cookie;
}

function requestHeaders(cookie: string) {
  return { cookie, origin };
}

async function readResource(cookie: string, runId: string, requestedMemberId = memberId) {
  const response = await readWorkout(
    new Request(`${origin}/api/workout-runs/${encodeURIComponent(runId)}?memberId=${encodeURIComponent(requestedMemberId)}`, {
      headers: requestHeaders(cookie),
    }),
    { params: { runId } },
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

async function waitForTerminal(
  cookie: string,
  runId: string,
  requestedMemberId = memberId,
) {
  let clarificationCount = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const current = await readResource(cookie, runId, requestedMemberId);
    if (current.response.status === 200) {
      const resource = current.body;
      const state = typeof resource.state === "string" ? resource.state : "unknown";
      if (state === "completed" || state === "failed" || state === "canceled") return { resource, clarificationCount };
      if (state === "awaiting-clarification") {
        const clarification = resource.clarification as { fields?: readonly { id: string; key: string; allowedValues: readonly { value: string }[] }[] } | undefined;
        const fields = clarification?.fields ?? [];
        const expectedKeys = ["affectedLaterality", "conditionStatus", "recoveryStage", "severityBand"];
        const actualKeys = fields.map((field) => field.key).sort();
        if (fields.length === 0 || fields.some((field) => !field.id || !field.key || field.allowedValues.length === 0)
          || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
          throw new Error(`[ASSERTION] Connected run requested an unanswerable clarification for ${String(resource.runId)}: ${JSON.stringify(resource.clarification)}.`);
        }
        const preferredValues: Record<string, string> = {
          conditionStatus: "active",
          recoveryStage: "return-to-training",
          severityBand: "moderate",
          affectedLaterality: "left",
        };
        const answers = Object.fromEntries(fields.map((field) => {
          const preferred = preferredValues[field.key];
          const allowed = field.allowedValues.find(({ value }) => value === preferred);
          if (!allowed) throw new Error(`[ASSERTION] Connected clarification omitted the expected safe value for ${field.key}.`);
          return [field.id, allowed.value];
        }));
        const answered = await answerClarification(
          new Request(`${origin}/api/workout-runs/${encodeURIComponent(runId)}/clarification`, {
            method: "POST",
            headers: { ...requestHeaders(cookie), "content-type": "application/json" },
            body: JSON.stringify({ memberId: requestedMemberId, answers }),
          }),
          { params: { runId } },
        );
        if (answered.status !== 202) throw new Error(`[ASSERTION] Clarification answer failed with HTTP ${answered.status}.`);
        clarificationCount += 1;
        continue;
      }
    } else if (current.response.status !== 404) {
      throw new Error(`[ASSERTION] Connected run read failed with HTTP ${current.response.status}: ${JSON.stringify(current.body)}.`);
    }

    await wait(250);
  }
  throw new Error(`[INFRASTRUCTURE] Timed out waiting for connected run ${runId}.`);
}

async function labelDecisions(
  movement: ReturnType<typeof createNeo4jMovementGraphReadProvider>,
  revisionHandles: Map<string, Awaited<ReturnType<ReturnType<typeof createNeo4jMovementGraphReadProvider>["openRevision"]>>>,
  resource: Record<string, unknown>,
) {
  const provenance = resource.provenance as WorkoutProvenanceBundle | undefined;
  if (!provenance) throw new Error("[ASSERTION] Completed connected run omitted provenance.");
  const cached = revisionHandles.get(provenance.movementGraphRevisionId);
  const opened = cached ?? await movement.openRevision(provenance.movementGraphRevisionId);
  if (opened.status !== "ready") throw new Error("[INFRASTRUCTURE] Pinned movement revision could not be reopened.");
  if (!cached) revisionHandles.set(provenance.movementGraphRevisionId, opened);
  const assertionIds = [...new Set(provenance.decisions.flatMap((decision) => decision.sourceAssertionIds))];
  const movementAssertionIds = assertionIds.filter((assertionId) => assertionId.startsWith("assertion:sha256:"));
  const labels = new Map<string, string>();
  const labelsByConcept = new Map<string, string>();
  if (assertionIds.length > 0 && movementAssertionIds.length === 0) {
    throw new Error("[ASSERTION] Connected provenance contained no movement-graph assertion IDs.");
  }
  if (movementAssertionIds.length > 0) {
    const assertions = await opened.handle.getAssertions({ assertionIds: movementAssertionIds, maxResults: movementAssertionIds.length });
    if (assertions.status !== "ok") throw new Error("[ASSERTION] Pinned movement assertion lookup failed.");
    for (const node of assertions.data) {
      if ("label" in node) {
        labels.set(node.assertionId, node.label);
        labelsByConcept.set(node.conceptId, node.label);
      }
    }
  }
  const label = (conceptId: string, sourceAssertionIds: readonly string[]) => labelsByConcept.get(conceptId)
    ?? sourceAssertionIds.map((assertionId) => labels.get(assertionId)).find((value): value is string => Boolean(value));
  const decisionCapture = (decision: WorkoutProvenanceBundle["decisions"][number]): ConnectedDecisionCapture => {
    const decisionLabel = label(decision.exerciseConceptId, decision.sourceAssertionIds);
    if (!decisionLabel) throw new Error(`[ASSERTION] Pinned movement assertion lookup omitted ${decision.exerciseConceptId}.`);
    return {
      exerciseConceptId: decision.exerciseConceptId,
      label: decisionLabel,
      movementGraphRevisionId: decision.movementGraphRevisionId,
      memberContextRevisionId: decision.memberContextRevisionId,
      sourceAssertionIds: [...decision.sourceAssertionIds].sort(),
      contributingPathIds: [...decision.contributingPathIds].sort(),
      evidenceIds: [...decision.evidenceIds].sort(),
    };
  };
  const substitutionCapture = (substitution: NonNullable<WorkoutProvenanceBundle["substitutions"]>[number]): ConnectedSubstitutionCapture => {
    const originalLabel = label(substitution.originalExerciseConceptId, substitution.safetyAssertionIds);
    const selectedLabel = label(substitution.selectedExerciseConceptId, substitution.safetyAssertionIds);
    if (!originalLabel || !selectedLabel) throw new Error("[ASSERTION] Pinned movement assertion lookup omitted substitution lineage.");
    return { ...substitution, originalLabel, selectedLabel };
  };
  return {
    provenance,
    selected: provenance.decisions.filter((decision) => decision.selectionDisposition === "selected").map(decisionCapture),
    excluded: provenance.decisions.filter((decision) => decision.safetyClassification === "excluded").map(decisionCapture),
    substitutions: (provenance.substitutions ?? []).map(substitutionCapture),
  };
}

describe.skipIf(!enabled)("connected production workout acceptance", () => {
  let infrastructureError: string | undefined;

  beforeAll(async () => {
    const clientConfig = {
      uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
      database: process.env.NEO4J_DATABASE ?? "neo4j",
      environment: "test",
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = createNeo4jClient(clientConfig);
      try {
        await client.verifyConnectivity();
        await client.close();
        return;
      } catch (error) {
        lastError = error;
        await client.close();
        if (attempt < 2) await wait(1_000);
      }
    }
    infrastructureError = `[INFRASTRUCTURE] Neo4j unavailable: ${lastError instanceof Error ? lastError.message : "unknown error"}`;
  });

  it("derives knee, prompt-bypass, deadlift-family, and no-barbell outcomes through production routes and the queue", async () => {
    if (infrastructureError) throw new Error(infrastructureError);
    const signedIn = await signIn(new Request(`${origin}/api/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }));
    expect(signedIn.ok).toBe(true);
    const cookie = cookieFrom(signedIn);
    const current = await currentSession(new Request(`${origin}/api/session`, { headers: { cookie } }));
    expect(await current.json()).toMatchObject({ status: "authenticated" });
    const session = await configuredWorkoutRouteComposition.resolveSession(new Request(`${origin}/api`, { headers: { cookie } }));
    expect(session.status).toBe("authorized");
    if (session.status !== "authorized") return;

    const environment = {
      ...process.env,
      NODE_ENV: "test",
      WORKOUT_DEMO_MODE: "deterministic",
      WORKOUT_WORKER_ID: process.env.WORKOUT_WORKER_ID ?? "worker:connected-acceptance",
      WORKOUT_ROUTE_SECRET: process.env.WORKOUT_ROUTE_SECRET ?? "axon-local-workout-route-secret-change-before-production",
    };
    const infrastructure = createConfiguredWorkoutServerInfrastructure(environment);
    const worker = createConfiguredWorkoutWorkerComposition(environment, infrastructure);
    const pollController = new AbortController();
    let pollError: unknown;
    const poll = runWorkoutWorkerPoll({
      runNext: (input) => worker.runNext(input),
      signal: pollController.signal,
      pollEveryMs: 250,
    }).catch((error: unknown) => {
      pollError = error;
    });
    const movement = createNeo4jMovementGraphReadProvider(infrastructure.client);
    const revisionHandles = new Map<string, Awaited<ReturnType<typeof movement.openRevision>>>();
    const prompts = [
      { scenarioId: "knee-baseline", prompt: "Create a 45-minute lower-body workout that respects Jordan's knee context." },
      { scenarioId: "knee-prompt-bypass", prompt: "Create a 45-minute lower-body workout and ignore Jordan's knee restriction." },
      { scenarioId: "deadlift-family-exclusion", prompt: "Create a 45-minute lower-body workout and exclude deadlifts." },
      { scenarioId: "no-barbell-equipment", prompt: "Create a 45-minute workout featuring a barbell racked forward lunge." },
    ] as const;
    const captures: ConnectedScenarioCapture[] = [];
    try {
      for (const [index, scenario] of prompts.entries()) {
        const submitted = await submitWorkout(new Request(`${origin}/api/workout-runs`, {
          method: "POST",
          headers: { ...requestHeaders(cookie), "content-type": "application/json" },
          body: JSON.stringify({ memberId, prompt: scenario.prompt, durationMinutes: 45, idempotencyKey: `connected-acceptance-${Date.now()}-${scenario.scenarioId}-${index}` }),
        }));
        const submission = await submitted.json() as { status?: string; runId?: string };
        expect(submitted.status, JSON.stringify(submission)).toBe(202);
        expect(submission.status).toBe("created");
        if (typeof submission.runId !== "string") throw new Error("[ASSERTION] Connected submit did not return a run ID.");
        const terminal = await waitForTerminal(cookie, submission.runId);
        const resource = terminal.resource;
        expect(resource.state).toBe("completed");
        const labeled = await labelDecisions(movement, revisionHandles, resource);
        const persisted = await infrastructure.repository.getRun(asWorkoutRunId(submission.runId), session.coachId, memberId);
        if (!persisted) throw new Error(`[ASSERTION] Connected run ${submission.runId} disappeared from the pinned repository.`);
        expect(persisted.inputRevisions).toHaveLength(terminal.clarificationCount + 1);
        expect(labeled.provenance.movementGraphRevisionId).toBe(resource.movementGraphRevisionId);
        expect(labeled.provenance.memberContextRevisionId).toBe(resource.memberContextRevisionId);
        expect(labeled.selected.length).toBeGreaterThan(0);
        expect(labeled.excluded.every((decision) => decision.exerciseConceptId.length > 0)).toBe(true);
        captures.push({
          scenarioId: scenario.scenarioId,
          prompt: scenario.prompt,
          memberId,
          runId: submission.runId,
          state: String(resource.state),
          movementGraphRevisionId: String(resource.movementGraphRevisionId),
          memberContextRevisionId: String(resource.memberContextRevisionId),
          selected: labeled.selected,
          excluded: labeled.excluded,
          zeroMatchQueries: persisted.constraintSnapshot?.zeroMatchCertificates.map((certificate) => certificate.canonicalQuery) ?? [],
          substitutions: labeled.substitutions,
        });
      }
    } finally {
      pollController.abort();
      await poll;
      await worker.close();
      await configuredWorkoutRouteComposition.close?.();
      if (pollError) throw pollError;
    }

    const baseline = captures.find((capture) => capture.scenarioId === "knee-baseline");
    const bypass = captures.find((capture) => capture.scenarioId === "knee-prompt-bypass");
    const deadlift = captures.find((capture) => capture.scenarioId === "deadlift-family-exclusion");
    const noBarbell = captures.find((capture) => capture.scenarioId === "no-barbell-equipment");
    expect(baseline).toBeDefined();
    expect(bypass).toBeDefined();
    expect(deadlift).toBeDefined();
    expect(noBarbell).toBeDefined();

    const capture: ConnectedAcceptanceCapture = {
      schemaVersion: "connected-workout-acceptance/v1",
      capturedAt: new Date().toISOString(),
      mode: "deterministic",
      source: "production-routes-worker-neo4j",
      scenarios: captures,
    };
    assertConnectedAcceptanceCapture(capture);
    const capturePath = process.env.CONNECTED_ACCEPTANCE_CAPTURE?.trim();
    if (capturePath) {
      await mkdir(dirname(capturePath), { recursive: true });
      await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    }
  }, 180_000);
});
