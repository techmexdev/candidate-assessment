import jordan from "../../data/member-context.json";
import type { MemberContextDocumentInput } from "../../src/domain/contracts/member-context";

export function buildMemberContextFixture(
  mutate?: (document: MemberContextDocumentInput) => void,
): MemberContextDocumentInput {
  const document = structuredClone(jordan) as MemberContextDocumentInput;
  mutate?.(document);
  return document;
}
