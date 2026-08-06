import type { Neo4jClient } from "./client";

export const MEMBER_CONTEXT_NEO4J_LIMITS = Object.freeze({
  maxNodesPerRevision: 5_000,
  maxRelationshipsPerRevision: 10_000,
});

export const MEMBER_CONTEXT_NEO4J_SCHEMA_QUERIES = Object.freeze([
  "CREATE CONSTRAINT member_context_revision_identity IF NOT EXISTS FOR (revision:MemberContextRevision) REQUIRE (revision.memberId, revision.contextRevisionId) IS UNIQUE",
  "CREATE CONSTRAINT member_context_fact_identity IF NOT EXISTS FOR (fact:MemberContextFact) REQUIRE (fact.memberId, fact.contextRevisionId, fact.semanticId) IS UNIQUE",
  "CREATE CONSTRAINT member_context_fact_assertion_identity IF NOT EXISTS FOR (fact:MemberContextFact) REQUIRE (fact.memberId, fact.contextRevisionId, fact.assertionId) IS UNIQUE",
  "CREATE CONSTRAINT member_context_relationship_assertion_identity IF NOT EXISTS FOR ()-[relationship:MEMBER_CONTEXT_RELATIONSHIP]-() REQUIRE (relationship.memberId, relationship.contextRevisionId, relationship.assertionId) IS UNIQUE",
  "CREATE CONSTRAINT member_context_catalog_identity IF NOT EXISTS FOR (catalog:MemberContextCatalog) REQUIRE catalog.memberId IS UNIQUE",
  "CREATE CONSTRAINT member_context_publication_attempt_identity IF NOT EXISTS FOR (attempt:MemberContextPublicationAttempt) REQUIRE attempt.attemptId IS UNIQUE",
  "CREATE CONSTRAINT member_context_revision_seal_identity IF NOT EXISTS FOR (seal:MemberContextRevisionSeal) REQUIRE seal.sealId IS UNIQUE",
  "CREATE CONSTRAINT member_context_activation_event_identity IF NOT EXISTS FOR (event:MemberContextActivationEvent) REQUIRE event.eventId IS UNIQUE",
  "CREATE INDEX member_context_fact_kind IF NOT EXISTS FOR (fact:MemberContextFact) ON (fact.memberId, fact.contextRevisionId, fact.kind)",
  "CREATE INDEX member_context_fact_effective_at IF NOT EXISTS FOR (fact:MemberContextFact) ON (fact.memberId, fact.contextRevisionId, fact.effectiveAt)",
  "CREATE INDEX member_context_fact_effective_on IF NOT EXISTS FOR (fact:MemberContextFact) ON (fact.memberId, fact.contextRevisionId, fact.effectiveOn)",
  "CREATE INDEX member_context_relationship_kind IF NOT EXISTS FOR ()-[relationship:MEMBER_CONTEXT_RELATIONSHIP]-() ON (relationship.memberId, relationship.contextRevisionId, relationship.kind)",
  "CREATE INDEX member_context_attempt_revision IF NOT EXISTS FOR (attempt:MemberContextPublicationAttempt) ON (attempt.memberId, attempt.contextRevisionId)",
  "CREATE INDEX member_context_activation_revision IF NOT EXISTS FOR (event:MemberContextActivationEvent) ON (event.memberId, event.contextRevisionId)",
]);

export async function setupMemberContextNeo4jSchema(client: Neo4jClient): Promise<void> {
  await client.executeWrite(async (transaction) => {
    for (const query of MEMBER_CONTEXT_NEO4J_SCHEMA_QUERIES) await transaction.run(query);
  });
}
