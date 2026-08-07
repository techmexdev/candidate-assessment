import { sameScope, type CopilotAnswerPacket } from "../../domain/contracts/copilot";
import type { CopilotIntentRecipe } from "../../domain/policies/copilot-retrieval-plan";

export type CopilotAnswerValidationResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly code:
        | "scope-mismatch"
        | "unknown-evidence"
        | "evidence-kind-mismatch"
        | "citation-missing"
        | "chart-invalid"
        | "quote-not-exact";
    };

function allowedKinds(recipe: CopilotIntentRecipe, sectionId: string) {
  if (sectionId === "next-action" || sectionId === "limitation") return recipe.evidenceKinds;
  return recipe.sectionEvidenceKinds[sectionId as keyof typeof recipe.sectionEvidenceKinds];
}

/** Final fail-closed gate. A valid evidence ID is insufficient unless its typed kind fits the rendered section. */
export function validateCopilotAnswer(
  packet: Readonly<CopilotAnswerPacket>,
  recipe: Readonly<CopilotIntentRecipe>,
  options: Readonly<{ sourceMessages?: ReadonlyMap<string, string> }> = {},
): CopilotAnswerValidationResult {
  if (packet.intentId !== recipe.intentId) return { status: "rejected", code: "scope-mismatch" };
  const atoms = new Map(packet.evidence.atoms.map((atom) => [atom.evidenceId, atom]));
  const cited = new Set(packet.citations.map((citation) => citation.evidenceId));
  for (const atom of atoms.values()) {
    if (!sameScope(packet, atom)) return { status: "rejected", code: "scope-mismatch" };
  }

  for (const section of packet.sections) {
    const kinds = allowedKinds(recipe, section.sectionId);
    if (!kinds) return { status: "rejected", code: "evidence-kind-mismatch" };
    for (const clause of section.clauses) {
      for (const evidenceId of clause.evidenceIds) {
        const atom = atoms.get(evidenceId);
        if (!atom) return { status: "rejected", code: "unknown-evidence" };
        if (!kinds.includes(atom.evidenceKind)) return { status: "rejected", code: "evidence-kind-mismatch" };
        if (!cited.has(evidenceId)) return { status: "rejected", code: "citation-missing" };
        if (atom.evidenceKind === "message") {
          const sourceText = options.sourceMessages?.get(evidenceId);
          if (!sourceText || !clause.text.includes(sourceText)) return { status: "rejected", code: "quote-not-exact" };
        }
      }
    }
  }

  if (packet.chart) {
    if (!recipe.chart
      || packet.chart.recipeId !== recipe.chart.recipeId
      || packet.chart.temporalMode !== recipe.chart.temporalMode
      || packet.chart.points.some((point) => point.evidenceIds.some((id) => !atoms.has(id) || !cited.has(id)))) {
      return { status: "rejected", code: "chart-invalid" };
    }
  }
  if (packet.churn) {
    const churnIds = [
      ...packet.churn.derived.evidenceIds,
      ...packet.churn.derived.reasons.flatMap((reason) => reason.evidenceIds),
      ...packet.churn.derived.excludedSourceReasons.flatMap((reason) => reason.evidenceIds),
      ...(packet.churn.source?.evidenceIds ?? []),
      ...(packet.churn.source?.reasons.flatMap((reason) => reason.evidenceIds) ?? []),
    ];
    if (churnIds.some((id) => !atoms.has(id))) return { status: "rejected", code: "unknown-evidence" };
    if (churnIds.some((id) => !cited.has(id))) return { status: "rejected", code: "citation-missing" };
  }
  return { status: "accepted" };
}
