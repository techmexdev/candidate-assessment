import type {
  CopilotContinuationClaims,
  CopilotOutcome,
  CopilotQuestionInput,
} from "../../domain/contracts/copilot";
import type { MemberContextReadHandle } from "../../domain/contracts/member-context-queries";

/** Runtime input carries one already-authorized, revision-pinned read handle. */
export type CopilotRuntimeRequest = {
  readonly requestId: string;
  readonly requestedFor: string;
  readonly evidenceAsOf: string;
  readonly input: CopilotQuestionInput;
  readonly memberContext: MemberContextReadHandle;
  readonly continuation?: Readonly<CopilotContinuationClaims>;
};

export interface CopilotRuntime {
  answer(
    request: Readonly<CopilotRuntimeRequest>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CopilotOutcome>;
}
