import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import { createWorkoutProvenanceBundle, type WorkoutDecision } from "../../domain/contracts/workout-provenance";
import { asWorkoutVersionId, type WorkoutRunId } from "../../domain/contracts/workout";
import type { ResolvedConstraintSnapshot, WorkoutClarificationDescriptor, WorkoutRevisionSealArtifact, WorkoutRun, WorkoutRunFailure } from "../../domain/contracts/workout-run";
import { validateWorkoutComposition } from "../../domain/policies/workout-composition";
import type { WorkoutCompositionCandidate } from "../../domain/policies/workout-composition";
import type { MovementSafetyContext } from "../../domain/contracts/movement-safety";
import type { MovementSubstitutionResult } from "../../domain/policies/movement-substitution";
import {
  canonicalWorkoutDecisionSetDigest,
  canonicalWorkoutDigest,
  canonicalWorkoutPayloadDigest,
  canonicalWorkoutProvenanceDigest,
  canonicalWorkoutRevisionSealDigest,
} from "../../graph/schema/workout-run-schema";
import { canonicalJson } from "../../graph/revisions/movement-graph";
import { createWorkoutComposerInput, proposalCitationsAreGrounded } from "../../agents/workout/tools";
import { parseWorkoutProposal } from "../../agents/workout/schemas";
import type { WorkoutComposer } from "../ports/workout-composer";
import type { ClaimWorkoutRunResult, WorkoutRunRepository } from "../ports/workout-run-repository";
import type {
  CatalogSafetyInjuryApplicability,
  CatalogSafetyResolvedMatch,
  EvaluateCatalogSafetyRequest,
  EvaluateCatalogSafetyResult,
} from "./evaluate-catalog-safety";
import type { ValidateWorkoutCandidatesResult, WorkoutCandidateValidationBinding } from "./validate-workout-candidates";

export type WorkoutGrantAuthorization =
  | { readonly status: "authorized"; readonly authorizationId: string }
  | { readonly status: "denied" };

export type ResolveWorkoutConstraintsResult =
  | {
      readonly status: "ready";
      readonly snapshot: Readonly<ResolvedConstraintSnapshot>;
      readonly canonicalIntent: {
        readonly focusConceptIds: readonly string[];
        readonly requestedDurationMinutes: number;
      };
      readonly injuryApplicability: readonly CatalogSafetyInjuryApplicability[];
      readonly explicitExclusions: readonly CatalogSafetyResolvedMatch[];
      readonly preferences: readonly CatalogSafetyResolvedMatch[];
      readonly availableEquipmentConceptIds?: readonly string[];
      readonly candidateProfiles: readonly WorkoutCompositionCandidate[];
      readonly revisionSeals: Readonly<WorkoutRevisionSealArtifact>;
    }
  | { readonly status: "clarification-required"; readonly candidateConceptIds: readonly string[]; readonly clarification?: WorkoutClarificationDescriptor }
  | { readonly status: "failed"; readonly reason: "graph-unavailable" | "insufficient-safety-context" };

export type ValidateRuntimeCandidatesRequest = {
  readonly authorizationId: string;
  readonly coachId: string;
  readonly memberId: string;
  readonly evaluationToken: string;
  readonly exerciseConceptIds: readonly string[];
  readonly binding: Readonly<WorkoutCandidateValidationBinding>;
};

export type ExecuteWorkoutRunDependencies = {
  readonly repository: WorkoutRunRepository;
  readonly authorizeGrant: (input: {
    readonly authorizationReferenceId: string;
    readonly runId: WorkoutRunId;
    readonly coachId: string;
    readonly memberId: string;
    readonly stage: "claim" | "constraints" | "catalog" | "composition" | "validation" | "completion";
  }) => Promise<WorkoutGrantAuthorization>;
  readonly resolveConstraints: (input: {
    readonly run: Readonly<WorkoutRun>;
    readonly authorizationId: string;
    readonly persistedSnapshot?: Readonly<ResolvedConstraintSnapshot>;
  }) => Promise<ResolveWorkoutConstraintsResult>;
  readonly evaluateCatalogSafety: (request: EvaluateCatalogSafetyRequest) => Promise<EvaluateCatalogSafetyResult>;
  readonly validateCandidates: (request: ValidateRuntimeCandidatesRequest) => Promise<ValidateWorkoutCandidatesResult>;
  /** Optional graph-backed resolver for equipment-ineligible requested exercises. */
  readonly findSubstitutes?: (request: {
    readonly exerciseConceptId: string;
    readonly availableEquipmentConceptIds: readonly string[];
    readonly excludedExerciseConceptIds: readonly string[];
    readonly conditions: readonly MovementSafetyContext[];
    readonly graphRevisionId: string;
  }) => Promise<MovementSubstitutionResult>;
  readonly composer: WorkoutComposer;
  readonly now: () => string;
  readonly createId: (kind: "workout-version" | "decision") => string;
  readonly afterCheckpoint?: (stage: "constraints" | "catalog" | "proposal" | "validation") => void | Promise<void>;
};

export type ExecuteWorkoutRunResult =
  | { readonly status: "completed" }
  | { readonly status: "awaiting-clarification" }
  | { readonly status: "not-claimable" }
  | { readonly status: "failed"; readonly reason: WorkoutRunFailure["kind"] }
  | { readonly status: "claim-lost" };

export class SimulatedWorkoutWorkerCrash extends Error {
  constructor(stage: string) {
    super(`simulated workout worker crash after ${stage}`);
    this.name = "SimulatedWorkoutWorkerCrash";
  }
}

function asCatalogSafety(result: Extract<EvaluateCatalogSafetyResult, { readonly status: "ready" }>): CatalogSafetyReadyResult {
  return {
    status: "ready",
    authority: "canonical",
    movementGraphRevisionId: result.movementGraphRevisionId,
    memberContextRevisionId: result.memberContextRevisionId,
    decisions: result.decisions,
    excluded: result.excluded,
    caution: result.caution,
    downranked: result.downranked,
    allowed: result.allowed,
    assertionIds: [...new Set(result.decisions.flatMap((decision) => decision.assertionIds))].sort(),
    evidenceIds: [...new Set(result.decisions.flatMap((decision) => decision.evidenceIds))].sort(),
  };
}

function decisionKind(decision: CatalogSafetyReadyResult["decisions"][number], selected: ReadonlySet<string>): WorkoutDecision["kind"] {
  if (decision.classification === "excluded") return "excluded";
  if (decision.classification === "caution") return "cautioned";
  if (decision.classification === "downranked") return "downranked";
  return selected.has(decision.exerciseConceptId) ? "selected" : "not-selected";
}

function proposalIds(proposal: { readonly sections: readonly { readonly items: readonly { readonly exerciseConceptId: string }[] }[] }) {
  return proposal.sections.flatMap((section) => section.items.map((item) => item.exerciseConceptId));
}

export function createExecuteWorkoutRun(dependencies: ExecuteWorkoutRunDependencies) {
  return async (input: {
    readonly runId: WorkoutRunId;
    readonly workerId: string;
    readonly leaseExpiresAt: string;
    readonly claimed?: Extract<ClaimWorkoutRunResult, { readonly status: "claimed" }>;
    readonly signal?: AbortSignal;
  }): Promise<ExecuteWorkoutRunResult> => {
    const claimed = input.claimed ?? await dependencies.repository.claim(input.runId, input.workerId, dependencies.now(), input.leaseExpiresAt);
    if (claimed.status !== "claimed") return { status: "not-claimable" };
    if (claimed.run.runId !== input.runId || claimed.fence.workerId !== input.workerId || claimed.fence.runId !== input.runId) {
      return { status: "not-claimable" };
    }
    const { run, fence } = claimed;
    const claimWasCanceled = () => input.signal?.aborted === true;

    const authorize = (stage: Parameters<ExecuteWorkoutRunDependencies["authorizeGrant"]>[0]["stage"]) => dependencies.authorizeGrant({
      authorizationReferenceId: run.authorizationReferenceId,
      runId: run.runId,
      coachId: run.coachId,
      memberId: run.memberId,
      stage,
    });
    const fail = async (kind: WorkoutRunFailure["kind"], stage: string): Promise<ExecuteWorkoutRunResult> => {
      const failed = await dependencies.repository.fail(fence, {
        kind,
        stage,
        safeMessage: "Workout generation could not be completed.",
        occurredAt: dependencies.now(),
      });
      return failed.status === "updated" ? { status: "failed", reason: kind } : { status: "claim-lost" };
    };
    const checkpoint = async (stage: "constraints" | "catalog" | "proposal" | "validation", stageDigest: string) => {
      if (claimWasCanceled()) return false;
      const saved = await dependencies.repository.appendEvent(fence, {
        kind: "stage",
        occurredAt: dependencies.now(),
        safeData: { stage, digest: stageDigest, generation: fence.generation },
      });
      if (saved.status !== "updated") return false;
      await dependencies.afterCheckpoint?.(stage);
      return true;
    };

    try {
      if (claimWasCanceled()) return { status: "claim-lost" };
      if ((await authorize("claim")).status !== "authorized") return fail("authorization-denied", "claim");
      const constraintsGrant = await authorize("constraints");
      if (constraintsGrant.status !== "authorized") return fail("authorization-denied", "constraints");
      const resolved = await dependencies.resolveConstraints({
        run,
        authorizationId: constraintsGrant.authorizationId,
        persistedSnapshot: run.constraintSnapshot,
      });
      if (claimWasCanceled()) return { status: "claim-lost" };
      if (resolved.status === "clarification-required") {
        const mutation = await dependencies.repository.awaitClarification(fence, dependencies.now(), resolved.clarification ?? resolved.candidateConceptIds);
        return mutation.status === "updated" ? { status: "awaiting-clarification" } : { status: "claim-lost" };
      }
      if (resolved.status === "failed") return fail(resolved.reason, "constraints");
      if (resolved.snapshot.movementGraphRevisionId !== run.movementGraphRevisionId
        || resolved.snapshot.memberContextRevisionId !== run.memberContextRevisionId
        || resolved.revisionSeals.movementGraphRevisionId !== run.movementGraphRevisionId
        || resolved.revisionSeals.memberContextRevisionId !== run.memberContextRevisionId
        || resolved.snapshot.digest.length === 0
        || resolved.canonicalIntent.requestedDurationMinutes !== run.requestedDurationMinutes) {
        return fail("insufficient-safety-context", "constraints");
      }
      const snapshotSaved = await dependencies.repository.saveConstraintSnapshot(fence, resolved.snapshot);
      const sealsSaved = await dependencies.repository.saveCompletionArtifact(fence, { kind: "revision-seals", payload: resolved.revisionSeals });
      if (snapshotSaved.status !== "updated" || sealsSaved.status !== "updated" || !await checkpoint("constraints", resolved.snapshot.digest)) return { status: "claim-lost" };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const catalogGrant = await authorize("catalog");
        if (catalogGrant.status !== "authorized") return fail("authorization-denied", "catalog");
        const evaluated = await dependencies.evaluateCatalogSafety({
          coachId: run.coachId,
          memberId: run.memberId,
          authorizationId: catalogGrant.authorizationId,
          runId: run.runId,
          memberContextRevisionId: run.memberContextRevisionId,
          movementGraphRevisionId: run.movementGraphRevisionId,
          injuryApplicability: resolved.injuryApplicability,
          explicitExclusions: resolved.explicitExclusions,
          preferences: resolved.preferences,
          ...(resolved.availableEquipmentConceptIds ? { availableEquipmentConceptIds: resolved.availableEquipmentConceptIds } : {}),
        });
        if (claimWasCanceled()) return { status: "claim-lost" };
        if (evaluated.status === "denied") return fail("authorization-denied", "catalog");
        if (evaluated.status === "clarification_required") {
          const mutation = await dependencies.repository.awaitClarification(fence, dependencies.now(), ["constraint:clarification"]);
          return mutation.status === "updated" ? { status: "awaiting-clarification" } : { status: "claim-lost" };
        }
        if (evaluated.status !== "ready") return fail(
          evaluated.reasonCode.includes("member") || evaluated.reasonCode.includes("constraint")
            ? "insufficient-safety-context"
            : "graph-unavailable",
          "catalog",
        );
        if (("authority" in evaluated && evaluated.authority !== undefined && evaluated.authority !== "canonical")
          || evaluated.movementGraphRevisionId !== run.movementGraphRevisionId
          || evaluated.memberContextRevisionId !== run.memberContextRevisionId
          || !evaluated.constraintDigest) {
          return fail("insufficient-safety-context", "catalog");
        }
        const catalogSafety = asCatalogSafety(evaluated);
        const equipmentExcluded = new Set(catalogSafety.excluded
          .filter((decision) => decision.contributions.some((contribution) => contribution.kind === "equipment"))
          .map((decision) => decision.exerciseConceptId));
        const requestedEquipmentExclusions = resolved.canonicalIntent.focusConceptIds
          .filter((conceptId) => equipmentExcluded.has(conceptId));
        const substitutionResults = new Map<string, Extract<MovementSubstitutionResult, { readonly status: "substitutes_found" }>>();
        if (dependencies.findSubstitutes && requestedEquipmentExclusions.length > 0) {
          const conditions: MovementSafetyContext[] = resolved.injuryApplicability.map((injury) => ({
            conditionConceptId: injury.conditionConceptId,
            affectedAnatomyConceptId: injury.affectedAnatomyConceptId,
            conditionStatus: injury.conditionStatus,
            recoveryStage: injury.recoveryStage,
            severityBand: injury.severityBand,
            affectedLaterality: injury.affectedLaterality,
            loadedLaterality: "unknown",
            sourceKey: `${injury.memberEvidenceId}\0${injury.evidenceId}`,
            sourceEvidenceId: injury.evidenceId,
          }));
          for (const exerciseConceptId of requestedEquipmentExclusions) {
            const substitutions = await dependencies.findSubstitutes({
              exerciseConceptId,
              availableEquipmentConceptIds: resolved.availableEquipmentConceptIds ?? [],
              excludedExerciseConceptIds: [...new Set(catalogSafety.excluded.map((decision) => decision.exerciseConceptId))],
              conditions,
              graphRevisionId: run.movementGraphRevisionId,
            });
            if (substitutions.status === "substitutes_found") substitutionResults.set(exerciseConceptId, substitutions);
          }
        }
        const safeDecisions = catalogSafety.decisions.filter((decision) => decision.classification !== "excluded");
        if (safeDecisions.length === 0) return fail("proposal-invalid", "catalog");
        const safetyEnvelopeDigest = canonicalWorkoutDigest(catalogSafety);
        const safetySaved = await dependencies.repository.saveCompletionArtifact(fence, { kind: "safety-envelope", payload: catalogSafety });
        if (safetySaved.status !== "updated") return { status: "claim-lost" };
        if (!await checkpoint("catalog", safetyEnvelopeDigest)) return { status: "claim-lost" };

        const composerGrant = await authorize("composition");
        if (composerGrant.status !== "authorized") return fail("authorization-denied", "composition");
        const composerInput = createWorkoutComposerInput({
          canonicalIntent: resolved.canonicalIntent,
          movementGraphRevisionId: run.movementGraphRevisionId,
          memberContextRevisionId: run.memberContextRevisionId,
          resolvedConstraintDigest: resolved.snapshot.digest,
          evaluationConstraintDigest: evaluated.constraintDigest,
          safetyEnvelopeDigest,
          catalogSafety,
          candidateProfiles: resolved.candidateProfiles,
        });
        if (composerInput.candidates.length === 0) return fail("proposal-invalid", "composition");
        const composed = await dependencies.composer.compose(composerInput, { signal: input.signal });
        if (claimWasCanceled()) return { status: "claim-lost" };
        if (composed.status !== "proposed") return fail("provider-failure", "composition");
        const parsed = parseWorkoutProposal(composed.proposal);
        if (parsed.status !== "valid" || !proposalCitationsAreGrounded(parsed.proposal, composerInput)) {
          return fail("proposal-invalid", "composition");
        }
        const selectedIds = proposalIds(parsed.proposal);
        const modelProposalDigest = canonicalWorkoutDigest(parsed.proposal);
        const proposalSaved = await dependencies.repository.saveCompletionArtifact(fence, { kind: "model-proposal", payload: parsed.proposal });
        if (proposalSaved.status !== "updated") return { status: "claim-lost" };
        if (!await checkpoint("proposal", modelProposalDigest)) return { status: "claim-lost" };

        const validationGrant = await authorize("validation");
        if (validationGrant.status !== "authorized") return fail("authorization-denied", "validation");
        const binding: WorkoutCandidateValidationBinding = {
          runId: run.runId,
          expectedEvaluationSessionId: evaluated.evaluationSessionId,
          movementGraphRevisionId: run.movementGraphRevisionId,
          memberContextRevisionId: run.memberContextRevisionId,
          constraintDigest: evaluated.constraintDigest,
        };
        const candidateValidation = await dependencies.validateCandidates({
          authorizationId: validationGrant.authorizationId,
          coachId: run.coachId,
          memberId: run.memberId,
          evaluationToken: evaluated.evaluationToken,
          exerciseConceptIds: selectedIds,
          binding,
        });
        if (claimWasCanceled()) return { status: "claim-lost" };
        if (candidateValidation.status === "evaluation-unavailable" && attempt === 0) continue;
        if (candidateValidation.status === "denied") return fail("authorization-denied", "validation");
        if (candidateValidation.status !== "accepted") return fail("proposal-invalid", "validation");
        const acceptedIds = candidateValidation.decisions.map((decision) => decision.exerciseConceptId);
        if (acceptedIds.length !== selectedIds.length || acceptedIds.some((id, index) => id !== selectedIds[index])) {
          return fail("proposal-invalid", "validation");
        }
        const decisionsById = new Map(catalogSafety.decisions.map((decision) => [decision.exerciseConceptId, decision]));
        if (candidateValidation.decisions.some((decision) => {
          const authoritative = decisionsById.get(decision.exerciseConceptId);
          return !authoritative || canonicalJson(authoritative) !== canonicalJson(decision);
        })) return fail("proposal-invalid", "validation");

        const selected = new Set(selectedIds);
        const substitutionForSelected = new Map<string, {
          readonly originalExerciseConceptId: string;
          readonly candidate: Extract<MovementSubstitutionResult, { readonly status: "substitutes_found" }>['candidates'][number];
        }>();
        for (const [originalExerciseConceptId, substitution] of substitutionResults) {
          for (const candidate of substitution.candidates) {
            if (selected.has(candidate.exerciseConceptId)) {
              substitutionForSelected.set(candidate.exerciseConceptId, { originalExerciseConceptId, candidate });
              break;
            }
          }
        }
        const provenanceDecisions: WorkoutDecision[] = catalogSafety.decisions.map((decision) => ({
          decisionId: dependencies.createId("decision"),
          kind: substitutionForSelected.has(decision.exerciseConceptId) ? "substituted" : decisionKind(decision, selected),
          selectionDisposition: selected.has(decision.exerciseConceptId) ? "selected" : "not-selected",
          safetyClassification: decision.classification,
          exerciseConceptId: decision.exerciseConceptId,
          movementGraphRevisionId: decision.movementGraphRevisionId,
          memberContextRevisionId: decision.memberContextRevisionId,
          sourceAssertionIds: [...decision.assertionIds],
          contributingPathIds: [...decision.assertionIds],
          evidenceIds: [...decision.evidenceIds],
          explanation: `${decision.classification} by canonical catalog safety policy`,
          ...(substitutionForSelected.has(decision.exerciseConceptId)
            ? { substitutedFromExerciseConceptId: substitutionForSelected.get(decision.exerciseConceptId)!.originalExerciseConceptId }
            : {}),
        }));
        const workoutVersionId = asWorkoutVersionId(dependencies.createId("workout-version"));
        const provenanceBase = createWorkoutProvenanceBundle({
          runId: run.runId,
          workoutVersionId,
          promptEntityId: run.inputRevisions.find((revision) => revision.inputRevisionId === run.activeInputRevisionId)!.protectedPromptSnapshotId,
          candidateSetEntityId: `candidate-set:${safetyEnvelopeDigest}`,
          modelProposalEntityId: `model-proposal:${modelProposalDigest}`,
          policyEntityId: run.policyRevision,
          movementGraphRevisionId: run.movementGraphRevisionId,
          memberContextRevisionId: run.memberContextRevisionId,
          decisions: provenanceDecisions,
          substitutions: [...substitutionForSelected.values()].map(({ originalExerciseConceptId, candidate }) => ({
            originalExerciseConceptId,
            selectedExerciseConceptId: candidate.exerciseConceptId,
            substitutionAssertionIds: candidate.assertionIds.filter((id) => id.includes(":substitution:") || id.includes(":sub:")),
            safetyAssertionIds: candidate.assertionIds,
            safetyEvidenceIds: candidate.safetyEvidenceIds ?? [],
            movementGraphRevisionId: run.movementGraphRevisionId,
            memberContextRevisionId: run.memberContextRevisionId,
          })),
          traceSchemaVersion: "workout-provenance/v1",
          digest: "sha256:pending",
        });
        const provenance = { ...provenanceBase, digest: canonicalWorkoutProvenanceDigest(provenanceBase) };
        const commonValidation = {
          runId: run.runId,
          claimGeneration: fence.generation,
          requestedDurationMinutes: run.requestedDurationMinutes,
          movementGraphRevisionId: run.movementGraphRevisionId,
          memberContextRevisionId: run.memberContextRevisionId,
          revisionSealDigest: canonicalWorkoutRevisionSealDigest(resolved.revisionSeals),
          requestDigest: run.requestDigest,
          resolvedConstraintDigest: resolved.snapshot.digest,
          safetyEnvelopeDigest,
          completeDecisionSetDigest: canonicalWorkoutDecisionSetDigest(provenanceDecisions),
          modelProposalDigest,
          workoutPayloadDigest: "sha256:pending",
          provenanceDigest: provenance.digest,
          proposal: parsed.proposal,
          candidates: resolved.candidateProfiles,
          catalogSafety,
        };
        const preliminary = validateWorkoutComposition(commonValidation);
        if (preliminary.status !== "valid") return fail("proposal-invalid", "validation");
        const workoutVersion = {
          workoutVersionId,
          version: 1,
          createdAt: dependencies.now(),
          workout: preliminary.workout,
        };
        const workoutPayloadDigest = canonicalWorkoutPayloadDigest(workoutVersion);
        const validated = validateWorkoutComposition({ ...commonValidation, workoutPayloadDigest });
        if (validated.status !== "valid") return fail("proposal-invalid", "validation");
        if (!await checkpoint("validation", canonicalWorkoutDigest(validated.receipt))) return { status: "claim-lost" };

        const completionGrant = await authorize("completion");
        if (completionGrant.status !== "authorized") return fail("authorization-denied", "completion");
        const completed = await dependencies.repository.complete({
          fence,
          authorizationReferenceId: run.authorizationReferenceId,
          workoutVersion: { ...workoutVersion, workout: validated.workout },
          provenance,
          validationReceipt: validated.receipt,
        });
        return completed.status === "completed" ? { status: "completed" } : { status: "claim-lost" };
      }
      return fail("proposal-invalid", "validation");
    } catch (error) {
      if (error instanceof SimulatedWorkoutWorkerCrash) throw error;
      return fail("graph-unavailable", "runtime");
    }
  };
}
