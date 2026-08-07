import type { CatalogSafetyClassification } from "../../domain/contracts/catalog-safety";
import type {
  WorkoutCompositionCandidate,
  WorkoutCompositionProposal,
  WorkoutDoseBounds,
} from "../../domain/policies/workout-composition";

export type WorkoutComposerCandidate = Pick<WorkoutCompositionCandidate, "exerciseConceptId" | "allowedSections"> & {
  readonly doseBounds: Readonly<WorkoutDoseBounds>;
  readonly safetyStatus: Exclude<CatalogSafetyClassification, "excluded">;
  readonly reasonCodes: readonly string[];
};

/** Deliberately excludes raw prompts, member facts, evidence text, graph queries, and authorization data. */
export type WorkoutComposerInput = {
  readonly schemaVersion: "workout-composer-input/v1";
  readonly canonicalIntent: {
    readonly focusConceptIds: readonly string[];
    readonly requestedDurationMinutes: number;
  };
  readonly candidates: readonly WorkoutComposerCandidate[];
};

export type WorkoutComposerResult =
  | { readonly status: "proposed"; readonly proposal: WorkoutCompositionProposal; readonly providerArtifactReferenceId?: string }
  | { readonly status: "failed"; readonly reason: "unavailable" | "timeout" | "invalid-structured-output" };

export interface WorkoutComposer {
  compose(input: Readonly<WorkoutComposerInput>): Promise<WorkoutComposerResult>;
}
