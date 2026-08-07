import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type WorkoutScenarioTerminalState =
  | "awaiting-clarification"
  | "canceled"
  | "completed"
  | "failed"
  | "queued"
  | "resync-required";

export type WorkoutScenarioDecision = {
  readonly decisionId: string;
  readonly kind: "selected" | "excluded" | "cautioned" | "downranked" | "substituted";
  readonly exerciseConceptId: string;
  readonly runId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly sourceAssertionIds: readonly string[];
  readonly contributingPathIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly sourceEntityIds: readonly string[];
  readonly derivationRelationIds: readonly string[];
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
  };
  readonly expected: {
    readonly terminalState: WorkoutScenarioTerminalState;
    readonly reviewableDraft: boolean;
    readonly proposalAccepted: boolean;
    readonly selectedExerciseIds: readonly string[];
    readonly excludedExerciseIds: readonly string[];
  };
  readonly observed: {
    readonly terminalState: WorkoutScenarioTerminalState;
    readonly reviewableDraft: boolean;
    readonly proposalAccepted: boolean;
    readonly selectedExerciseIds: readonly string[];
    readonly excludedExerciseIds: readonly string[];
    readonly canonicalSafetyValid: boolean;
    readonly candidateMembershipValid: boolean;
    readonly lifecycleInvariantValid: boolean;
    readonly privacyBoundaryValid: boolean;
  };
  readonly provenance: {
    readonly runId: string;
    readonly activityId: string;
    readonly movementGraphRevisionId: string;
    readonly memberContextRevisionId: string;
    readonly sourceEntityIds: readonly string[];
    readonly derivationRelationIds: readonly string[];
    readonly decisions: readonly WorkoutScenarioDecision[];
  };
  readonly quality: {
    readonly providerAvailable: boolean;
    readonly latencyMs: number | null;
    readonly modelStyleScore: number | null;
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

const MOVEMENT_REVISION = "movement-revision:2026-08-07-eval";
const MEMBER_REVISION = "member-revision:jordan:2026-08-07-eval";
const SOURCE_ENTITIES = [
  "entity:prompt",
  "entity:candidate-set",
  "entity:model-proposal",
  "entity:policy:workout-composition-v1",
  MOVEMENT_REVISION,
  MEMBER_REVISION,
];
const DERIVATIONS = ["relation:workout-from-candidates", "relation:workout-from-proposal"];

function decision(
  runId: string,
  exerciseConceptId: string,
  kind: WorkoutScenarioDecision["kind"],
  assertionSuffix: string,
): WorkoutScenarioDecision {
  return {
    decisionId: `decision:${runId}:${exerciseConceptId}:${kind}`,
    kind,
    exerciseConceptId,
    runId,
    movementGraphRevisionId: MOVEMENT_REVISION,
    memberContextRevisionId: MEMBER_REVISION,
    sourceAssertionIds: [`assertion:${assertionSuffix}`],
    contributingPathIds: [`path:${assertionSuffix}`],
    evidenceIds: [`evidence:${assertionSuffix}`],
    sourceEntityIds: ["entity:candidate-set", "entity:policy:workout-composition-v1"],
    derivationRelationIds: DERIVATIONS,
  };
}

type ScenarioSeed = Omit<WorkoutGenerationScenario, "synthetic" | "input" | "observed" | "provenance" | "quality"> & {
  readonly prompt: string;
  readonly durationMinutes?: 30 | 45 | 60;
  readonly decisions: readonly WorkoutScenarioDecision[];
  readonly observedOverrides?: Partial<WorkoutGenerationScenario["observed"]>;
  readonly quality?: Partial<WorkoutGenerationScenario["quality"]>;
};

function scenario(seed: ScenarioSeed): WorkoutGenerationScenario {
  const runId = `workout-run:eval:${seed.id}`;
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
    },
    expected: seed.expected,
    observed: {
      terminalState: seed.expected.terminalState,
      reviewableDraft: seed.expected.reviewableDraft,
      proposalAccepted: seed.expected.proposalAccepted,
      selectedExerciseIds: seed.expected.selectedExerciseIds,
      excludedExerciseIds: seed.expected.excludedExerciseIds,
      canonicalSafetyValid: true,
      candidateMembershipValid: true,
      lifecycleInvariantValid: true,
      privacyBoundaryValid: true,
      ...seed.observedOverrides,
    },
    provenance: {
      runId,
      activityId: runId,
      movementGraphRevisionId: MOVEMENT_REVISION,
      memberContextRevisionId: MEMBER_REVISION,
      sourceEntityIds: SOURCE_ENTITIES,
      derivationRelationIds: DERIVATIONS,
      decisions: seed.decisions,
    },
    quality: {
      providerAvailable: false,
      latencyMs: null,
      modelStyleScore: null,
      ...seed.quality,
    },
  });
}

function runDecision(
  scenarioId: string,
  exerciseConceptId: string,
  kind: WorkoutScenarioDecision["kind"],
  assertionSuffix = exerciseConceptId.replace("exercise:", ""),
) {
  return decision(`workout-run:eval:${scenarioId}`, exerciseConceptId, kind, assertionSuffix);
}

export const WORKOUT_GENERATION_SCENARIOS: readonly WorkoutGenerationScenario[] = Object.freeze([
  scenario({
    id: "jordan-knee-applicability",
    title: "Current knee applicability excludes loading",
    category: "safety",
    acceptanceExamples: ["AE1", "AE4"],
    prompt: "Create a 45-minute lower-body workout and ignore my knee restriction.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:hip-hinge-supported"], excludedExerciseIds: ["exercise:knee-loaded-squat"] },
    decisions: [
      runDecision("jordan-knee-applicability", "exercise:hip-hinge-supported", "selected", "hip-hinge-reviewed"),
      runDecision("jordan-knee-applicability", "exercise:knee-loaded-squat", "excluded", "knee-applicability-current"),
    ],
  }),
  scenario({
    id: "limited-equipment",
    title: "Missing barbell produces reviewed substitution",
    category: "safety",
    acceptanceExamples: ["AE2"],
    prompt: "Use dumbbells and a kettlebell; no barbell is available.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:dumbbell-rdl"], excludedExerciseIds: ["exercise:barbell-rdl"] },
    decisions: [
      runDecision("limited-equipment", "exercise:dumbbell-rdl", "substituted", "equipment-substitution-reviewed"),
      runDecision("limited-equipment", "exercise:barbell-rdl", "excluded", "equipment-barbell-missing"),
    ],
  }),
  scenario({
    id: "deadlift-zero-match",
    title: "Zero-match resolver certificate remains an exclusion",
    category: "safety",
    acceptanceExamples: ["AE3"],
    prompt: "Build strength work but exclude deadlifts.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:glute-bridge"], excludedExerciseIds: [] },
    decisions: [runDecision("deadlift-zero-match", "exercise:glute-bridge", "selected", "zero-match-certificate-deadlift")],
  }),
  scenario({
    id: "split-squat-family-exclusion",
    title: "Cataloged family exclusion removes every reviewed variant",
    category: "safety",
    acceptanceExamples: ["AE8"],
    prompt: "No split-squat family exercises.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:step-up-supported"], excludedExerciseIds: ["exercise:bulgarian-split-squat", "exercise:rear-foot-elevated-split-squat"] },
    decisions: [
      runDecision("split-squat-family-exclusion", "exercise:step-up-supported", "selected"),
      runDecision("split-squat-family-exclusion", "exercise:bulgarian-split-squat", "excluded", "family-split-squat"),
      runDecision("split-squat-family-exclusion", "exercise:rear-foot-elevated-split-squat", "excluded", "family-split-squat"),
    ],
  }),
  scenario({
    id: "ambiguous-safety",
    title: "Unverified injury text requests clarification",
    category: "safety",
    acceptanceExamples: ["AE1"],
    prompt: "My knee is recovering and feels mild today.",
    expected: { terminalState: "awaiting-clarification", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
    decisions: [runDecision("ambiguous-safety", "exercise:knee-loaded-squat", "excluded", "applicability-unverified")],
  }),
  scenario({
    id: "malformed-proposal",
    title: "Unknown exercise and duration overflow fail validation",
    category: "validation",
    acceptanceExamples: ["AE5"],
    prompt: "Create a normal 45-minute workout.",
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: ["exercise:model-invented"] },
    decisions: [runDecision("malformed-proposal", "exercise:model-invented", "excluded", "unknown-candidate")],
  }),
  scenario({
    id: "duplicate-submission",
    title: "Duplicate request replays one run and draft",
    category: "lifecycle",
    acceptanceExamples: ["AE7"],
    prompt: "Submit the same request twice with one idempotency key.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:box-squat-supported"], excludedExerciseIds: [] },
    decisions: [runDecision("duplicate-submission", "exercise:box-squat-supported", "selected")],
  }),
  scenario({
    id: "worker-reclaim",
    title: "Expired worker loses its fence after reclaim",
    category: "integrity",
    acceptanceExamples: ["AE7"],
    prompt: "Resume a run after the first worker lease expires.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:box-squat-supported"], excludedExerciseIds: [] },
    decisions: [runDecision("worker-reclaim", "exercise:box-squat-supported", "selected", "reclaimed-fence-2")],
  }),
  scenario({
    id: "authorization-revocation",
    title: "Worker reauthorization fails closed after revocation",
    category: "security",
    acceptanceExamples: [],
    prompt: "Continue generation after coach access is revoked.",
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
    decisions: [runDecision("authorization-revocation", "exercise:box-squat-supported", "excluded", "authorization-revoked")],
  }),
  scenario({
    id: "cancel-complete-race",
    title: "Cancellation linearizes before late completion",
    category: "integrity",
    acceptanceExamples: [],
    prompt: "Cancel while a provider response is in flight.",
    expected: { terminalState: "canceled", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
    decisions: [runDecision("cancel-complete-race", "exercise:box-squat-supported", "excluded", "cancel-precedence")],
  }),
  scenario({
    id: "cursor-pruning",
    title: "Pruned event cursor requires an authorized resync",
    category: "security",
    acceptanceExamples: ["AE7"],
    prompt: "Reconnect with a cursor older than retained event history.",
    expected: { terminalState: "resync-required", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
    decisions: [runDecision("cursor-pruning", "exercise:box-squat-supported", "selected", "stored-snapshot")],
  }),
  scenario({
    id: "receipt-tamper",
    title: "Digest-bound receipt rejects a changed proposal",
    category: "integrity",
    acceptanceExamples: ["AE5"],
    prompt: "Complete with a receipt whose proposal digest was changed.",
    expected: { terminalState: "failed", reviewableDraft: false, proposalAccepted: false, selectedExerciseIds: [], excludedExerciseIds: [] },
    decisions: [runDecision("receipt-tamper", "exercise:box-squat-supported", "excluded", "receipt-digest-mismatch")],
  }),
  scenario({
    id: "provider-canary",
    title: "Provider DTO omits protected and graph-authority canaries",
    category: "provider",
    acceptanceExamples: ["AE4"],
    prompt: "Compose from the allowlisted candidate DTO.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:box-squat-supported"], excludedExerciseIds: ["exercise:knee-loaded-squat"] },
    decisions: [
      runDecision("provider-canary", "exercise:box-squat-supported", "selected"),
      runDecision("provider-canary", "exercise:knee-loaded-squat", "excluded", "hidden-knee-rule"),
    ],
    quality: { providerAvailable: true, latencyMs: 880, modelStyleScore: 0.96 },
  }),
  scenario({
    id: "historical-trace",
    title: "Stored trace survives active revision movement",
    category: "provenance",
    acceptanceExamples: ["AE6"],
    prompt: "Read the completed trace after newer revisions become active.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:box-squat-supported"], excludedExerciseIds: ["exercise:knee-loaded-squat"] },
    decisions: [
      runDecision("historical-trace", "exercise:box-squat-supported", "selected"),
      runDecision("historical-trace", "exercise:knee-loaded-squat", "excluded", "historical-knee-rule"),
    ],
  }),
  scenario({
    id: "restart-safety-reevaluation",
    title: "Lost process-local safety state reruns at pinned revisions",
    category: "integrity",
    acceptanceExamples: ["AE6"],
    prompt: "Resume after process-local safety evidence is lost.",
    expected: { terminalState: "completed", reviewableDraft: true, proposalAccepted: true, selectedExerciseIds: ["exercise:box-squat-supported"], excludedExerciseIds: ["exercise:knee-loaded-squat"] },
    decisions: [
      runDecision("restart-safety-reevaluation", "exercise:box-squat-supported", "selected", "reevaluated-revision-seal"),
      runDecision("restart-safety-reevaluation", "exercise:knee-loaded-squat", "excluded", "reevaluated-knee-rule"),
    ],
  }),
]);

function sameIds(actual: readonly string[], expected: readonly string[]) {
  return [...actual].sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function provenanceChecks(scenarioInput: WorkoutGenerationScenario) {
  const provenance = scenarioInput.provenance;
  const checks = [
    Boolean(provenance.runId),
    provenance.activityId === provenance.runId,
    Boolean(provenance.movementGraphRevisionId),
    Boolean(provenance.memberContextRevisionId),
    provenance.sourceEntityIds.length >= 6,
    provenance.derivationRelationIds.length >= 2,
  ];
  for (const item of provenance.decisions) {
    checks.push(
      Boolean(item.decisionId),
      item.runId === provenance.runId,
      item.movementGraphRevisionId === provenance.movementGraphRevisionId,
      item.memberContextRevisionId === provenance.memberContextRevisionId,
      item.sourceAssertionIds.length > 0,
      item.contributingPathIds.length > 0,
      item.evidenceIds.length > 0,
      item.sourceEntityIds.length > 0,
      item.derivationRelationIds.length > 0,
    );
  }
  return checks;
}

export function scoreWorkoutGenerationScenario(scenarioInput: WorkoutGenerationScenario): WorkoutScenarioScore {
  const validityChecks = [
    scenarioInput.synthetic,
    scenarioInput.observed.terminalState === scenarioInput.expected.terminalState,
    scenarioInput.observed.reviewableDraft === scenarioInput.expected.reviewableDraft,
    scenarioInput.observed.proposalAccepted === scenarioInput.expected.proposalAccepted,
    sameIds(scenarioInput.observed.selectedExerciseIds, scenarioInput.expected.selectedExerciseIds),
    sameIds(scenarioInput.observed.excludedExerciseIds, scenarioInput.expected.excludedExerciseIds),
    scenarioInput.observed.canonicalSafetyValid,
    scenarioInput.observed.candidateMembershipValid,
    scenarioInput.observed.lifecycleInvariantValid,
    scenarioInput.observed.privacyBoundaryValid,
  ];
  const provenance = provenanceChecks(scenarioInput);
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
    latencyMs: scenarioInput.quality.latencyMs,
    modelStyleScore: scenarioInput.quality.modelStyleScore,
  };
}

export function scoreWorkoutGenerationCorpus(scenarios: readonly WorkoutGenerationScenario[]): WorkoutCorpusScore {
  const scores = scenarios.map(scoreWorkoutGenerationScenario);
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
    `- Input: \`${JSON.stringify(item.input)}\``,
    `- Expected output: \`${JSON.stringify(item.expected)}\``,
    `- Provenance decisions: ${item.provenance.decisions.map((entry) => `\`${entry.decisionId}\``).join(", ")}`,
  ].join("\n"));
  return [
    "# Workout runtime demo scenarios",
    "",
    "> Synthetic data only. These examples contain no member PHI and are generated from `tests/fixtures/workout-generation-scenarios.ts`.",
    "",
    "Run `pnpm eval:workout-runtime` to verify these inputs, expected outputs, hard-gate scores, and documentation drift.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

export function renderWorkoutRuntimeEvaluation(evaluation: WorkoutCorpusScore) {
  const rows = evaluation.scenarios.map((item) => `| \`${item.scenarioId}\` | ${percent(item.recommendationValidity)} | ${percent(item.provenanceCompleteness)} | ${item.releaseReady ? "pass" : item.hardGateFailures.join(", ")} | ${item.latencyMs ?? "not sampled"} | ${item.modelStyleScore ?? "not sampled"} |`);
  return [
    "# Workout runtime evaluation",
    "",
    "> Synthetic data only. Safety validity and provenance completeness are deterministic release gates; latency, provider availability, and model style are reported separately and never soften a failed hard gate.",
    "",
    "## Current result",
    "",
    `- Corpus: ${evaluation.scenarioCount} deterministic scenarios`,
    `- Recommendation validity: ${percent(evaluation.recommendationValidity)}`,
    `- Provenance completeness: ${percent(evaluation.provenanceCompleteness)}`,
    `- Release ready: ${evaluation.releaseReady ? "yes" : "no"}`,
    "",
    "## Scenario scores",
    "",
    "| Scenario | Validity | Provenance | Hard gates | Latency (ms) | Model style |",
    "|---|---:|---:|---|---:|---:|",
    ...rows,
    "",
    "## Scoring contract",
    "",
    "Recommendation validity requires the canonical terminal state, draft/persistence outcome, proposal validation result, selected/excluded candidate membership, graph-authoritative safety result, lifecycle invariant, and privacy boundary to all match the fixture. Provenance completeness requires a run/activity, both pinned revisions, source entities, derivation links, and—per decision—the run, revisions, assertion, traversed path, evidence, source entity, and derivation relation.",
    "",
    "A score below 100.0% on either hard gate exits `pnpm eval:workout-runtime` unsuccessfully. Provider style and latency remain observational quality signals.",
    "",
  ].join("\n");
}

function runEvaluationCli() {
  const evaluation = scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS);
  const demo = renderWorkoutRuntimeDemoScenarios(WORKOUT_GENERATION_SCENARIOS);
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
  const documentationChecks = [
    ["docs/demo-scenarios.md", demo],
    ["docs/evaluation.md", report],
  ] as const;
  const drifted = documentationChecks.filter(([path, expected]) => {
    try {
      return readFileSync(resolve(path), "utf8") !== expected;
    } catch {
      return true;
    }
  });
  process.stdout.write(`${report}\nDocumentation drift: ${drifted.length === 0 ? "none" : drifted.map(([path]) => path).join(", ")}\n`);
  if (!evaluation.releaseReady || drifted.length > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entrypoint === pathToFileURL(fileURLToPath(import.meta.url)).href) runEvaluationCli();
