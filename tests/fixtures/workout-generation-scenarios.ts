import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExecuteWorkoutRun, type ExecuteWorkoutRunDependencies } from "../../src/application/use-cases/execute-workout-run";
import type { WorkoutComposerInput, WorkoutComposerProposal } from "../../src/application/ports/workout-composer";
import { validateWorkoutProvenance, workoutDecisionWasSelected, type WorkoutProvenanceBundle } from "../../src/domain/contracts/workout-provenance";
import type { WorkoutRun, WorkoutRunState } from "../../src/domain/contracts/workout-run";
import { asWorkoutInputRevisionId, asWorkoutRunId, type ImmutableWorkoutVersion, type WorkoutDose } from "../../src/domain/contracts/workout";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import { catalogDecision, catalogResult, compositionCandidate, TEST_MEMBER_REVISION, TEST_MOVEMENT_REVISION } from "./workout-runtime-builder";

export type WorkoutScenarioTerminalState = WorkoutRunState | "resync-required";

type RuntimeMode =
  | "complete"
  | "clarification"
  | "malformed-proposal"
  | "duplicate-submission"
  | "worker-reclaim"
  | "authorization-revocation"
  | "cancel-complete-race"
  | "cursor-pruning"
  | "receipt-tamper"
  | "provider-canary"
  | "historical-trace"
  | "restart-safety-reevaluation";

type RuntimeFixture = {
  readonly mode: RuntimeMode;
  readonly selectedExerciseIds: readonly string[];
  readonly excludedExerciseIds: readonly string[];
  readonly cautionExerciseIds?: readonly string[];
  readonly downrankedExerciseIds?: readonly string[];
};

export type WorkoutGenerationScenario = {
  readonly id: string;
  readonly title: string;
  readonly category: "safety" | "validation" | "lifecycle" | "security" | "integrity" | "provenance" | "provider";
  readonly acceptanceExamples: readonly (`AE${number}`)[];
  readonly synthetic: true;
  readonly input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly prompt: string;
    readonly durationMinutes: 30 | 45 | 60;
    /** Deterministic adapter inputs. They configure the runtime; they are not observations. */
    readonly runtimeFixture: RuntimeFixture;
  };
  readonly expected: {
    readonly terminalState: WorkoutScenarioTerminalState;
    readonly reviewableDraft: boolean;
    readonly proposalAccepted: boolean;
    readonly selectedExerciseIds: readonly string[];
    readonly excludedExerciseIds: readonly string[];
  };
};

export type WorkoutScenarioCapture = {
  readonly scenarioId: string;
  readonly observed: {
    readonly terminalState: WorkoutScenarioTerminalState;
    readonly underlyingRunState: WorkoutRunState;
    readonly reviewableDraft: boolean;
    readonly proposalAccepted: boolean;
    readonly selectedExerciseIds: readonly string[];
    readonly excludedExerciseIds: readonly string[];
  };
  readonly run: {
    readonly runId: string;
    readonly movementGraphRevisionId: string;
    readonly memberContextRevisionId: string;
  };
  readonly workout?: ImmutableWorkoutVersion;
  readonly provenance?: WorkoutProvenanceBundle;
  readonly evidence: {
    readonly candidateExerciseIds: readonly string[];
    readonly publicEvents: unknown;
    readonly providerInput?: WorkoutComposerInput;
    readonly sensitiveCanaries: readonly string[];
    readonly duplicateCreationStatus?: string;
    readonly validationAttempts: number;
    readonly staleCursorStatus?: string;
  };
  readonly quality: {
    readonly providerMeasurement: "unavailable";
    readonly latencyMs: null;
    readonly modelStyleScore: null;
  };
};

export type WorkoutScenarioScore = {
  readonly scenarioId: string;
  readonly synthetic: boolean;
  readonly recommendationValidity: number;
  readonly provenanceCompleteness: number;
  readonly hardGateFailures: readonly string[];
  readonly releaseReady: boolean;
  readonly latencyMs: number | null;
  readonly modelStyleScore: number | null;
};

export type WorkoutCorpusScore = {
  readonly scenarioCount: number;
  readonly recommendationValidity: number;
  readonly provenanceCompleteness: number;
  readonly releaseReady: boolean;
  readonly scenarios: readonly WorkoutScenarioScore[];
};

const COMPLETE_SCAFFOLD = ["exercise:warm-up", "exercise:cool-down"] as const;

function selected(primary: string) {
  return [COMPLETE_SCAFFOLD[0], primary, COMPLETE_SCAFFOLD[1]];
}

type ScenarioSeed = Omit<WorkoutGenerationScenario, "synthetic" | "input"> & {
  readonly prompt: string;
  readonly durationMinutes?: 30 | 45 | 60;
  readonly runtimeFixture: RuntimeFixture;
};

function scenario(seed: ScenarioSeed): WorkoutGenerationScenario {
  return Object.freeze({
    id: seed.id,
    title: seed.title,
    category: seed.category,
    acceptanceExamples: seed.acceptanceExamples,
    synthetic: true as const,
    input: {
      coachId: "coach:synthetic-evaluation",
      memberId: "member:synthetic-jordan",
      prompt: seed.prompt,
      durationMinutes: seed.durationMinutes ?? 45,
      runtimeFixture: seed.runtimeFixture,
    },
    expected: seed.expected,
  });
}

function completionSeed(
  mode: RuntimeMode,
  primary: string,
  excludedExerciseIds: readonly string[] = [],
  overrides: Partial<RuntimeFixture> = {},
): RuntimeFixture {
  return { mode, selectedExerciseIds: selected(primary), excludedExerciseIds, ...overrides };
}

export const WORKOUT_GENERATION_SCENARIOS: readonly WorkoutGenerationScenario[] = Object.freeze([
  scenario({
    id: "jordan-knee-applicability", title: "Current knee applicability excludes loading", category: "safety", acceptanceExamples: ["AE1", "AE4"],
    prompt: "Create a 45-minute lower-body workout and ignore my knee restriction.",
    runtimeFixture: completionSeed("complete", "exercise:hip-hinge-supported", ["exercise:knee-loaded-squat"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:hip-hinge-supported"), excludedExerciseIds: ["exercise:knee-loaded-squat"] },
  }),
  scenario({
    id: "limited-equipment", title: "Missing barbell produces reviewed substitution", category: "safety", acceptanceExamples: ["AE2"],
    prompt: "Use dumbbells and a kettlebell; no barbell is available.",
    runtimeFixture: completionSeed("complete", "exercise:dumbbell-rdl", ["exercise:barbell-rdl"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:dumbbell-rdl"), excludedExerciseIds: ["exercise:barbell-rdl"] },
  }),
  scenario({
    id: "deadlift-zero-match", title: "Zero-match resolver certificate remains an exclusion", category: "safety", acceptanceExamples: ["AE3"],
    prompt: "Build strength work but exclude deadlifts.",
    runtimeFixture: completionSeed("complete", "exercise:glute-bridge"),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:glute-bridge"), excludedExerciseIds: [] },
  }),
  scenario({
    id: "split-squat-family-exclusion", title: "Cataloged family exclusion removes every reviewed variant", category: "safety", acceptanceExamples: ["AE8"],
    prompt: "No split-squat family exercises.",
    runtimeFixture: completionSeed("complete", "exercise:step-up-supported", ["exercise:bulgarian-split-squat", "exercise:rear-foot-elevated-split-squat"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:step-up-supported"), excludedExerciseIds: ["exercise:bulgarian-split-squat", "exercise:rear-foot-elevated-split-squat"] },
  }),
  scenario({
    id: "ambiguous-safety", title: "Unverified injury text requests clarification", category: "safety", acceptanceExamples: ["AE1"],
    prompt: "My knee is recovering and feels mild today.",
    runtimeFixture: { mode: "clarification", selectedExerciseIds: [], excludedExerciseIds: [] },
    expected: { terminalState: "awaiting-clarification", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
  }),
  scenario({
    id: "malformed-proposal", title: "Unknown exercise and duration overflow fail validation", category: "validation", acceptanceExamples: ["AE5"],
    prompt: "Create a normal 45-minute workout.",
    runtimeFixture: { mode: "malformed-proposal", selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
  }),
  scenario({
    id: "duplicate-submission", title: "Duplicate request replays one run and draft", category: "lifecycle", acceptanceExamples: ["AE7"],
    prompt: "Submit the same request twice with one idempotency key.",
    runtimeFixture: completionSeed("duplicate-submission", "exercise:box-squat-supported"),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
  }),
  scenario({
    id: "worker-reclaim", title: "Expired worker loses its fence after reclaim", category: "integrity", acceptanceExamples: ["AE7"],
    prompt: "Resume a run after the first worker lease expires.",
    runtimeFixture: completionSeed("worker-reclaim", "exercise:box-squat-supported"),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
  }),
  scenario({
    id: "authorization-revocation", title: "Worker reauthorization fails closed after revocation", category: "security", acceptanceExamples: [],
    prompt: "Continue generation after coach access is revoked.",
    runtimeFixture: { mode: "authorization-revocation", selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
  }),
  scenario({
    id: "cancel-complete-race", title: "Cancellation linearizes before late completion", category: "integrity", acceptanceExamples: [],
    prompt: "Cancel while a provider response is in flight.",
    runtimeFixture: { mode: "cancel-complete-race", selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
    expected: { terminalState: "canceled", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
  }),
  scenario({
    id: "cursor-pruning", title: "Pruned event cursor requires an authorized resync", category: "security", acceptanceExamples: ["AE7"],
    prompt: "Reconnect with a cursor older than retained event history.",
    runtimeFixture: completionSeed("cursor-pruning", "exercise:box-squat-supported"),
    expected: { terminalState: "resync-required", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
  }),
  scenario({
    id: "receipt-tamper", title: "Digest-bound receipt rejects a changed proposal", category: "integrity", acceptanceExamples: ["AE5"],
    prompt: "Complete with a receipt whose proposal digest was changed.",
    runtimeFixture: { mode: "receipt-tamper", selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: [] },
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
  }),
  scenario({
    id: "provider-canary", title: "Provider DTO omits protected and graph-authority canaries", category: "provider", acceptanceExamples: ["AE4"],
    prompt: "Compose from the allowlisted candidate DTO.",
    runtimeFixture: completionSeed("provider-canary", "exercise:box-squat-supported", ["exercise:knee-loaded-squat"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: ["exercise:knee-loaded-squat"] },
  }),
  scenario({
    id: "historical-trace", title: "Stored trace survives active revision movement", category: "provenance", acceptanceExamples: ["AE6"],
    prompt: "Read the completed trace after newer revisions become active.",
    runtimeFixture: completionSeed("historical-trace", "exercise:box-squat-supported", ["exercise:knee-loaded-squat"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: ["exercise:knee-loaded-squat"] },
  }),
  scenario({
    id: "restart-safety-reevaluation", title: "Lost process-local safety state reruns at pinned revisions", category: "integrity", acceptanceExamples: ["AE6"],
    prompt: "Resume after process-local safety evidence is lost.",
    runtimeFixture: completionSeed("restart-safety-reevaluation", "exercise:box-squat-supported", ["exercise:knee-loaded-squat"]),
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: selected("exercise:box-squat-supported"), excludedExerciseIds: ["exercise:knee-loaded-squat"] },
  }),
]);

const START = "2026-08-07T10:00:00.000Z";
const LATER = "2026-08-07T10:02:00.000Z";
const LEASE = "2026-08-07T10:12:00.000Z";

function queuedRun(scenarioInput: WorkoutGenerationScenario): WorkoutRun {
  const runId = asWorkoutRunId(`workout-run:eval:${scenarioInput.id}`);
  return {
    runId,
    coachId: scenarioInput.input.coachId,
    memberId: scenarioInput.input.memberId,
    authorizationReferenceId: `grant-ref:${scenarioInput.id}`,
    idempotencyKeyDigest: `sha256:idempotency:${scenarioInput.id}`,
    requestDigest: `sha256:request:${scenarioInput.id}`,
    requestedDurationMinutes: scenarioInput.input.durationMinutes,
    modelConfigurationId: "model:deterministic-evaluation",
    policyRevision: "policy:workout-composition-v1",
    movementGraphRevisionId: TEST_MOVEMENT_REVISION,
    memberContextRevisionId: TEST_MEMBER_REVISION,
    state: "queued",
    inputRevisions: [{
      inputRevisionId: asWorkoutInputRevisionId(`input:eval:${scenarioInput.id}:1`),
      revision: 1,
      protectedPromptSnapshotId: `prompt:protected:${scenarioInput.id}`,
      promptDigest: `sha256:prompt:${scenarioInput.id}`,
      effectiveInputDigest: `sha256:effective:${scenarioInput.id}`,
      createdAt: START,
    }],
    activeInputRevisionId: asWorkoutInputRevisionId(`input:eval:${scenarioInput.id}:1`),
  };
}

function proposalForScenario(scenarioInput: WorkoutGenerationScenario): WorkoutComposerProposal {
  const fixture = scenarioInput.input.runtimeFixture;
  if (fixture.mode === "malformed-proposal") {
    const invalidItem: WorkoutComposerProposal["sections"][number]["items"][number] = {
      exerciseConceptId: "exercise:model-invented",
      dose: { kind: "timed", sets: 1, workSecondsPerSet: 9_999 },
      restSeconds: 0,
      rationale: "Invalid synthetic proposal",
      citationIds: ["evidence:exercise:model-invented"],
    };
    return {
      schemaVersion: "workout-proposal/v1",
      sections: [{
        kind: "main",
        items: [invalidItem],
      }],
    };
  }
  const ids = fixture.selectedExerciseIds;
  if (ids.length < 3) throw new Error(`scenario ${scenarioInput.id} needs at least three selected exercises`);
  const total = scenarioInput.input.durationMinutes * 60;
  const warmSeconds = Math.round(total * 0.2);
  const coolSeconds = Math.round(total * 0.15);
  const mainSeconds = total - warmSeconds - coolSeconds;
  const groups = [[ids[0]!], ids.slice(1, -1), [ids.at(-1)!]] as const;
  const budgets = [warmSeconds, mainSeconds, coolSeconds] as const;
  const kinds = ["warm-up", "main", "cool-down"] as const;
  return {
    schemaVersion: "workout-proposal/v1",
    sections: groups.map((group, groupIndex) => {
      const base = Math.floor(budgets[groupIndex]! / group.length);
      return {
        kind: kinds[groupIndex]!,
        items: group.map((exerciseConceptId, itemIndex) => ({
          exerciseConceptId,
          dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: base + (itemIndex === group.length - 1 ? budgets[groupIndex]! - base * group.length : 0) },
          restSeconds: 0,
          rationale: "Deterministic evaluation composition",
          citationIds: [`evidence:${exerciseConceptId}`],
        })),
      };
    }),
  };
}

function safetyDecisions(scenarioInput: WorkoutGenerationScenario) {
  const fixture = scenarioInput.input.runtimeFixture;
  const caution = new Set(fixture.cautionExerciseIds ?? []);
  const downranked = new Set(fixture.downrankedExerciseIds ?? []);
  return [
    ...fixture.selectedExerciseIds.map((id) => catalogDecision(id, caution.has(id) ? "caution" : downranked.has(id) ? "downranked" : "allowed")),
    ...fixture.excludedExerciseIds.map((id) => catalogDecision(id, "excluded")),
  ];
}

function resultLists(provenance: WorkoutProvenanceBundle | undefined) {
  if (!provenance) return { selectedExerciseIds: [] as string[], excludedExerciseIds: [] as string[] };
  return {
    selectedExerciseIds: provenance.decisions.filter(workoutDecisionWasSelected).map((item) => item.exerciseConceptId),
    excludedExerciseIds: provenance.decisions.filter((item) => item.safetyClassification === "excluded").map((item) => item.exerciseConceptId),
  };
}

export async function executeWorkoutGenerationScenario(scenarioInput: WorkoutGenerationScenario): Promise<WorkoutScenarioCapture> {
  let currentTime = START;
  const fixture = scenarioInput.input.runtimeFixture;
  const repository = new InMemoryWorkoutRunRepository({
    cursorSecret: `evaluation-secret:${scenarioInput.id}`,
    maxEventsPerRun: fixture.mode === "cursor-pruning" ? 2 : undefined,
    now: () => currentTime,
  });
  const run = queuedRun(scenarioInput);
  await repository.createOrFind(run);
  let duplicateCreationStatus: string | undefined;
  if (fixture.mode === "duplicate-submission") duplicateCreationStatus = (await repository.createOrFind(run)).status;
  let staleCursor: string | undefined;
  if (fixture.mode === "cursor-pruning") {
    const page = await repository.readEvents(run.runId, run.coachId, run.memberId, { limit: 1 });
    if (page.status === "ready") staleCursor = page.nextCursor;
  }
  if (fixture.mode === "worker-reclaim") {
    await repository.claim(run.runId, "worker:expired", START, "2026-08-07T10:01:00.000Z");
    currentTime = LATER;
  }

  const decisions = safetyDecisions(scenarioInput);
  const catalog = catalogResult(decisions);
  let providerInput: WorkoutComposerInput | undefined;
  let validationAttempts = 0;
  const originalComplete = repository.complete.bind(repository);
  if (fixture.mode === "receipt-tamper") {
    repository.complete = async (input) => {
      const rejected = await originalComplete({
        ...input,
        validationReceipt: { ...input.validationReceipt, modelProposalDigest: "sha256:tampered" },
      });
      if (rejected.status === "invalid-receipt") {
        await repository.fail(input.fence, {
          kind: "proposal-invalid",
          stage: "completion",
          safeMessage: "Workout generation could not be completed.",
          occurredAt: currentTime,
        });
      }
      return rejected;
    };
  }

  const dependencies: ExecuteWorkoutRunDependencies = {
    repository,
    authorizeGrant: async ({ stage }) => fixture.mode === "authorization-revocation" && stage === "completion"
      ? { status: "denied" }
      : { status: "authorized", authorizationId: `authorization:eval:${scenarioInput.id}` },
    resolveConstraints: async () => fixture.mode === "clarification"
      ? { status: "clarification-required", candidateConceptIds: ["joint:knee"] }
      : {
          status: "ready",
          snapshot: {
            schemaVersion: "resolved-constraint-snapshot/v1",
            movementGraphRevisionId: TEST_MOVEMENT_REVISION,
            memberContextRevisionId: TEST_MEMBER_REVISION,
            canonicalConstraintIds: fixture.excludedExerciseIds,
            applicabilityAssertionIds: ["assertion:eval:applicability"],
            evidenceIds: ["evidence:eval:member-context"],
            zeroMatchCertificates: scenarioInput.id === "deadlift-zero-match" ? [{ resolverId: "resolver:eval", canonicalQuery: "deadlift", searchPolicyVersion: "search:eval", maximumResults: 25, emptyResult: true, evidenceId: "evidence:eval:zero-match" }] : [],
            resolverVersion: "resolver:eval",
            searchPolicyVersion: "search:eval",
            digest: `sha256:constraints:${scenarioInput.id}`,
          },
          canonicalIntent: { focusConceptIds: ["movement-pattern:synthetic"], requestedDurationMinutes: scenarioInput.input.durationMinutes },
          injuryApplicability: [],
          explicitExclusions: [],
          preferences: [],
          candidateProfiles: decisions.map((item) => compositionCandidate(item.exerciseConceptId)),
          revisionSeals: {
            schemaVersion: "workout-revision-seals/v1",
            movementGraphRevisionId: TEST_MOVEMENT_REVISION,
            movementGraphSealId: "revision-seal:movement-eval",
            movementGraphSealDigest: "sha256:movement-eval",
            memberContextRevisionId: TEST_MEMBER_REVISION,
            memberContextSealId: "revision-seal:member-eval",
            memberContextSealDigest: "sha256:member-eval",
          },
        },
    evaluateCatalogSafety: async () => ({
      ...catalog,
      evaluationToken: `evaluation-token:${scenarioInput.id}`,
      evaluationSessionId: `evaluation-session:${scenarioInput.id}`,
      constraintDigest: `sha256:evaluation:${scenarioInput.id}`,
      expiresAt: LEASE,
      zeroMatchEvidenceIds: scenarioInput.id === "deadlift-zero-match" ? ["evidence:eval:zero-match"] : [],
    }),
    composer: {
      compose: async (input) => {
        providerInput = input;
        return { status: "proposed", proposal: proposalForScenario(scenarioInput) };
      },
    },
    validateCandidates: async ({ exerciseConceptIds }) => {
      validationAttempts += 1;
      if (fixture.mode === "restart-safety-reevaluation" && validationAttempts === 1) {
        return { status: "evaluation-unavailable", reasonCode: "evaluation-expired" };
      }
      if (fixture.mode === "malformed-proposal") {
        return { status: "violations", accepted: [], violations: [{ reasonCode: "unknown-candidate" }] };
      }
      return { status: "accepted", decisions: exerciseConceptIds.map((id) => decisions.find((item) => item.exerciseConceptId === id)!).filter(Boolean) };
    },
    now: () => currentTime,
    createId: (kind) => `${kind}:eval:${scenarioInput.id}`,
    afterCheckpoint: async (stage) => {
      if (fixture.mode === "cancel-complete-race" && stage === "catalog") {
        await repository.cancel(run.runId, run.coachId, run.memberId, currentTime);
      }
    },
  };

  const execution = await createExecuteWorkoutRun(dependencies)({ runId: run.runId, workerId: "worker:evaluation", leaseExpiresAt: LEASE });
  const storedRun = await repository.getRun(run.runId, run.coachId, run.memberId);
  if (!storedRun) throw new Error(`evaluation lost run ${run.runId}`);
  const workout = await repository.getWorkout(run.runId, run.coachId, run.memberId);
  const provenance = await repository.getProvenance(run.runId, run.coachId, run.memberId);
  const events = await repository.readEvents(run.runId, run.coachId, run.memberId, { limit: 100 });
  let staleCursorStatus: string | undefined;
  if (staleCursor) staleCursorStatus = (await repository.readEvents(run.runId, run.coachId, run.memberId, { cursor: staleCursor, limit: 100 })).status;
  const terminalState = staleCursorStatus === "resync_required" ? "resync-required" : storedRun.state;
  const lists = resultLists(provenance);
  return {
    scenarioId: scenarioInput.id,
    observed: {
      terminalState,
      underlyingRunState: storedRun.state,
      reviewableDraft: Boolean(workout),
      proposalAccepted: execution.status === "completed",
      ...lists,
    },
    run: { runId: storedRun.runId, movementGraphRevisionId: storedRun.movementGraphRevisionId, memberContextRevisionId: storedRun.memberContextRevisionId },
    ...(workout ? { workout } : {}),
    ...(provenance ? { provenance } : {}),
    evidence: {
      candidateExerciseIds: decisions.map((item) => item.exerciseConceptId),
      publicEvents: events,
      ...(providerInput ? { providerInput } : {}),
      sensitiveCanaries: [run.authorizationReferenceId, run.inputRevisions[0]!.protectedPromptSnapshotId, `authorization:eval:${scenarioInput.id}`],
      ...(duplicateCreationStatus ? { duplicateCreationStatus } : {}),
      validationAttempts,
      ...(staleCursorStatus ? { staleCursorStatus } : {}),
    },
    quality: { providerMeasurement: "unavailable", latencyMs: null, modelStyleScore: null },
  };
}

export async function executeWorkoutGenerationCorpus(scenarios: readonly WorkoutGenerationScenario[]) {
  const captures: WorkoutScenarioCapture[] = [];
  for (const scenarioInput of scenarios) captures.push(await executeWorkoutGenerationScenario(scenarioInput));
  return captures;
}

function sameIds(actual: readonly string[], expected: readonly string[]) {
  return [...actual].sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function runtimeInvariantChecks(scenarioInput: WorkoutGenerationScenario, capture: WorkoutScenarioCapture) {
  const decisions = capture.provenance?.decisions ?? [];
  const candidateIds = new Set(capture.evidence.candidateExerciseIds);
  const publicBoundary = JSON.stringify({ providerInput: capture.evidence.providerInput, publicEvents: capture.evidence.publicEvents });
  const canonicalSafetyValid = capture.observed.selectedExerciseIds.every((id) => decisions.some((decision) => decision.exerciseConceptId === id
    && workoutDecisionWasSelected(decision)
    && decision.safetyClassification !== "excluded"));
  const candidateMembershipValid = [...capture.observed.selectedExerciseIds, ...capture.observed.excludedExerciseIds].every((id) => candidateIds.has(id))
    && capture.observed.excludedExerciseIds.every((id) => decisions.some((decision) => decision.exerciseConceptId === id && decision.safetyClassification === "excluded"));
  const lifecycleInvariantValid = capture.observed.reviewableDraft === (capture.observed.underlyingRunState === "completed")
    && capture.observed.proposalAccepted === (capture.observed.underlyingRunState === "completed")
    && (capture.observed.underlyingRunState === "completed" ? Boolean(capture.provenance) : !capture.provenance)
    && (scenarioInput.input.runtimeFixture.mode !== "duplicate-submission" || capture.evidence.duplicateCreationStatus === "replayed")
    && (scenarioInput.input.runtimeFixture.mode !== "restart-safety-reevaluation" || capture.evidence.validationAttempts === 2)
    && (scenarioInput.input.runtimeFixture.mode !== "cursor-pruning" || capture.evidence.staleCursorStatus === "resync_required");
  const privacyBoundaryValid = capture.evidence.sensitiveCanaries.every((canary) => !publicBoundary.includes(canary));
  return [canonicalSafetyValid, candidateMembershipValid, lifecycleInvariantValid, privacyBoundaryValid];
}

function provenanceChecks(scenarioInput: WorkoutGenerationScenario, capture: WorkoutScenarioCapture) {
  const base = [
    Boolean(capture.run.runId),
    Boolean(capture.run.movementGraphRevisionId),
    Boolean(capture.run.memberContextRevisionId),
  ];
  const completed = capture.observed.underlyingRunState === "completed";
  if (!completed) return [...base, capture.provenance === undefined];
  const provenance = capture.provenance;
  if (!provenance) return [...base, false];
  const checks = [
    ...base,
    provenance.activity.activityId === capture.run.runId,
    provenance.movementGraphRevisionId === capture.run.movementGraphRevisionId,
    provenance.memberContextRevisionId === capture.run.memberContextRevisionId,
    provenance.entities.length >= 7,
    provenance.relations.length >= 9,
    validateWorkoutProvenance(provenance).status === "valid",
  ];
  for (const item of provenance.decisions) {
    checks.push(
      Boolean(item.decisionId),
      item.movementGraphRevisionId === provenance.movementGraphRevisionId,
      item.memberContextRevisionId === provenance.memberContextRevisionId,
      item.sourceAssertionIds.length > 0,
      item.contributingPathIds.length > 0,
      item.evidenceIds.length > 0,
    );
  }
  return checks;
}

export function scoreWorkoutGenerationScenario(scenarioInput: WorkoutGenerationScenario, capture: WorkoutScenarioCapture): WorkoutScenarioScore {
  const validityChecks = [
    scenarioInput.synthetic,
    capture.scenarioId === scenarioInput.id,
    capture.observed.terminalState === scenarioInput.expected.terminalState,
    capture.observed.reviewableDraft === scenarioInput.expected.reviewableDraft,
    capture.observed.proposalAccepted === scenarioInput.expected.proposalAccepted,
    sameIds(capture.observed.selectedExerciseIds, scenarioInput.expected.selectedExerciseIds),
    sameIds(capture.observed.excludedExerciseIds, scenarioInput.expected.excludedExerciseIds),
    ...runtimeInvariantChecks(scenarioInput, capture),
  ];
  const provenance = provenanceChecks(scenarioInput, capture);
  const recommendationValidity = validityChecks.filter(Boolean).length / validityChecks.length;
  const provenanceCompleteness = provenance.filter(Boolean).length / provenance.length;
  const hardGateFailures = [
    ...(recommendationValidity === 1 ? [] : ["recommendation-validity"]),
    ...(provenanceCompleteness === 1 ? [] : ["provenance-completeness"]),
  ];
  return {
    scenarioId: scenarioInput.id,
    synthetic: scenarioInput.synthetic,
    recommendationValidity,
    provenanceCompleteness,
    hardGateFailures,
    releaseReady: hardGateFailures.length === 0,
    latencyMs: capture.quality.latencyMs,
    modelStyleScore: capture.quality.modelStyleScore,
  };
}

export function scoreWorkoutGenerationCorpus(scenarios: readonly WorkoutGenerationScenario[], captures: readonly WorkoutScenarioCapture[]): WorkoutCorpusScore {
  const byId = new Map(captures.map((capture) => [capture.scenarioId, capture]));
  const scores = scenarios.map((scenarioInput) => {
    const capture = byId.get(scenarioInput.id);
    if (!capture) throw new Error(`missing evaluation capture for ${scenarioInput.id}`);
    return scoreWorkoutGenerationScenario(scenarioInput, capture);
  });
  const divisor = Math.max(1, scores.length);
  return {
    scenarioCount: scores.length,
    recommendationValidity: scores.reduce((sum, item) => sum + item.recommendationValidity, 0) / divisor,
    provenanceCompleteness: scores.reduce((sum, item) => sum + item.provenanceCompleteness, 0) / divisor,
    releaseReady: scores.length > 0 && scores.every((item) => item.releaseReady),
    scenarios: scores,
  };
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderWorkoutRuntimeDemoScenarios(scenarios: readonly WorkoutGenerationScenario[]) {
  const sections = scenarios.map((item) => [
    `## \`${item.id}\` — ${item.title}`,
    "",
    `- Category: ${item.category}`,
    `- Acceptance examples: ${item.acceptanceExamples.length > 0 ? item.acceptanceExamples.join(", ") : "runtime invariant"}`,
    `- Form input: \`${JSON.stringify({ coachId: item.input.coachId, memberId: item.input.memberId, prompt: item.input.prompt, durationMinutes: item.input.durationMinutes })}\``,
    `- Expected output: \`${JSON.stringify(item.expected)}\``,
  ].join("\n"));
  return [
    "# Workout runtime demo scenarios",
    "",
    "> Synthetic data only. These examples contain no member PHI and are generated from `tests/fixtures/workout-generation-scenarios.ts`.",
    "",
    "Run `pnpm eval:workout-runtime` to execute these inputs through the deterministic workout use case and repository, score captured outputs, and verify documentation drift.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

const DOCUMENTED_EXAMPLE_IDS = [
  "jordan-knee-applicability",
  "limited-equipment",
  "split-squat-family-exclusion",
] as const;

function markdownCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function durationLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function doseLabel(dose: Readonly<WorkoutDose>) {
  return dose.kind === "timed"
    ? `${dose.sets} × ${durationLabel(dose.workSecondsPerSet)}`
    : `${dose.sets} × ${dose.repetitionsPerSet} reps`;
}

/**
 * Submission examples are rendered from executed captures, not expected fixture
 * values. Keeping this file in the evaluation drift gate prevents the README
 * examples from becoming hand-maintained success stories.
 */
export function renderWorkoutRuntimeExamples(
  scenarios: readonly WorkoutGenerationScenario[],
  captures: readonly WorkoutScenarioCapture[],
) {
  const scenariosById = new Map(scenarios.map((item) => [item.id, item]));
  const capturesById = new Map(captures.map((item) => [item.scenarioId, item]));
  const sections = DOCUMENTED_EXAMPLE_IDS.map((scenarioId, index) => {
    const scenarioInput = scenariosById.get(scenarioId);
    const capture = capturesById.get(scenarioId);
    if (!scenarioInput || !capture?.workout || !capture.provenance || !capture.evidence.providerInput) {
      throw new Error(`documented example ${scenarioId} did not produce a complete captured run`);
    }
    const planRows = capture.workout.workout.sections.flatMap((section) => section.items.map((item) =>
      `| ${section.kind} | \`${item.exerciseConceptId}\` | ${doseLabel(item.dose)} | ${durationLabel(item.restSeconds)} | ${markdownCell(item.rationale)} |`,
    ));
    const traceRows = capture.provenance.decisions.map((decision) =>
      `| \`${decision.exerciseConceptId}\` | ${decision.selectionDisposition ?? "legacy"} | ${decision.safetyClassification ?? decision.kind} | ${decision.sourceAssertionIds.map((id) => `\`${id}\``).join("; ")} | ${decision.contributingPathIds.map((id) => `\`${id}\``).join("; ")} | ${decision.evidenceIds.map((id) => `\`${id}\``).join("; ")} | ${markdownCell(decision.explanation)} |`,
    );
    const providerCandidateIds = capture.evidence.providerInput.candidates.map((candidate) => candidate.exerciseConceptId);
    return [
      `## Example ${index + 1}: ${scenarioInput.title}`,
      "",
      `**Input** (${scenarioInput.input.durationMinutes} minutes):`,
      "",
      "```json",
      JSON.stringify({
        memberId: scenarioInput.input.memberId,
        prompt: scenarioInput.input.prompt,
        durationMinutes: scenarioInput.input.durationMinutes,
      }, null, 2),
      "```",
      "",
      "**Captured plan**",
      "",
      "| Section | Canonical exercise | Dose | Rest | Rationale |",
      "|---|---|---:|---:|---|",
      ...planRows,
      "",
      `Total planned duration: ${durationLabel(capture.workout.workout.timing.totalSeconds)}; requested: ${durationLabel(capture.workout.workout.timing.requestedDurationSeconds)}; difference: ${capture.workout.workout.timing.differenceSeconds}s.`,
      "",
      "**Filtering boundary**",
      "",
      `- Candidate catalog before safety: ${capture.evidence.candidateExerciseIds.map((id) => `\`${id}\``).join(", ")}.`,
      `- Hard-filtered before the model: ${capture.observed.excludedExerciseIds.length > 0 ? capture.observed.excludedExerciseIds.map((id) => `\`${id}\``).join(", ") : "none"}.`,
      `- Allowlisted candidates visible to the model: ${providerCandidateIds.map((id) => `\`${id}\``).join(", ")}.`,
      "- The model received canonical IDs, dose bounds, safety status, and citation IDs; it did not receive the raw prompt, member facts, authorization material, Cypher, or excluded candidates.",
      "",
      "**Provenance trace**",
      "",
      `Run \`${capture.run.runId}\` pins Movement revision \`${capture.run.movementGraphRevisionId}\` and Member Context revision \`${capture.run.memberContextRevisionId}\`. Trace digest: \`${capture.provenance.digest}\`.`,
      "",
      "| Exercise | Disposition | Safety | Source assertions | Contributing path | Evidence | Decision |",
      "|---|---|---|---|---|---|---|",
      ...traceRows,
      "",
    ].join("\n");
  });
  return [
    "# Executed workout examples",
    "",
    "> Synthetic data only. This file is generated from executed runtime captures. The offline harness uses deterministic graph-port fixtures and a deterministic composer, while exercising the real workout use case, validator, repository, lifecycle, and PROV-O projection. It does not claim a live model or clinical validation.",
    "",
    "Regenerate and drift-check these examples with `pnpm eval:workout-runtime`. Print only this document with `pnpm eval:workout-runtime -- --print-examples`.",
    "",
    ...sections,
  ].join("\n");
}

export function renderWorkoutRuntimeEvaluation(evaluation: WorkoutCorpusScore) {
  const rows = evaluation.scenarios.map((item) => `| \`${item.scenarioId}\` | ${percent(item.recommendationValidity)} | ${percent(item.provenanceCompleteness)} | ${item.releaseReady ? "pass" : item.hardGateFailures.join(", ")} | ${item.latencyMs ?? "unavailable"} | ${item.modelStyleScore ?? "unavailable"} |`);
  return [
    "# Workout runtime evaluation",
    "",
    "> Synthetic inputs are executed through the real deterministic workout use case and in-memory repository. Expected values never populate observations. Safety validity and provenance completeness are release gates; provider latency and style are unavailable in this offline harness and therefore non-gating.",
    "",
    "## Current result",
    "",
    `- Corpus: ${evaluation.scenarioCount} executable deterministic scenarios`,
    `- Recommendation validity: ${percent(evaluation.recommendationValidity)}`,
    `- Provenance completeness: ${percent(evaluation.provenanceCompleteness)}`,
    `- Release ready: ${evaluation.releaseReady ? "yes" : "no"}`,
    "",
    "## Scenario scores",
    "",
    "| Scenario | Validity | Provenance | Hard gates | Provider latency (ms) | Provider style |",
    "|---|---:|---:|---|---:|---:|",
    ...rows,
    "",
    "## Scoring contract",
    "",
    "The harness creates a queued run, executes `createExecuteWorkoutRun` against `InMemoryWorkoutRunRepository`, and derives terminal state, draft presence, proposal acceptance, candidate membership, safety classification, privacy-boundary checks, lifecycle checks, and provenance from stored runtime outputs. Lifecycle scenarios additionally exercise replay, reclaim, cancellation, cursor pruning, receipt rejection, and safety reevaluation. A mutation test deliberately corrupts a captured output and proves the gate fails.",
    "",
    "Completed runs require a valid stored PROV-O projection with pinned revisions and complete decision evidence. Non-completed runs require pinned run identity and the absence of a fabricated completion trace. A score below 100.0% on either hard gate exits `pnpm eval:workout-runtime` unsuccessfully.",
    "",
    "This offline corpus does not call a model provider, so provider latency and style are explicitly unavailable. They must be measured by a separate provider-backed canary before becoming observational signals; they never soften a failed hard gate.",
    "",
  ].join("\n");
}

async function runEvaluationCli() {
  const captures = await executeWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS);
  const evaluation = scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS, captures);
  const demo = renderWorkoutRuntimeDemoScenarios(WORKOUT_GENERATION_SCENARIOS);
  const examples = renderWorkoutRuntimeExamples(WORKOUT_GENERATION_SCENARIOS, captures);
  const report = renderWorkoutRuntimeEvaluation(evaluation);
  const args = new Set(process.argv.slice(2));
  if (args.has("--print-demo")) {
    process.stdout.write(demo);
    return;
  }
  if (args.has("--print-evaluation")) {
    process.stdout.write(report);
    return;
  }
  if (args.has("--print-examples")) {
    process.stdout.write(examples);
    return;
  }
  const documentationChecks = [
    ["docs/demo-scenarios.md", demo],
    ["docs/example-plans.md", examples],
    ["docs/evaluation.md", report],
  ] as const;
  const drifted = documentationChecks.filter(([path, expected]) => {
    try { return readFileSync(resolve(path), "utf8") !== expected; } catch { return true; }
  });
  process.stdout.write(`${report}\nDocumentation drift: ${drifted.length === 0 ? "none" : drifted.map(([path]) => path).join(", ")}\n`);
  if (!evaluation.releaseReady || drifted.length > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entrypoint === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  void runEvaluationCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
