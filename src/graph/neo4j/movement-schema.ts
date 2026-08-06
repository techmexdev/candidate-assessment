import type { Neo4jClient } from "./client";

export const MOVEMENT_NEO4J_SCHEMA_QUERIES = Object.freeze([
  "CREATE CONSTRAINT movement_catalog_singleton IF NOT EXISTS FOR (catalog:GraphCatalog) REQUIRE catalog.catalogId IS UNIQUE",
  "CREATE CONSTRAINT movement_revision_identity IF NOT EXISTS FOR (revision:MovementRevision) REQUIRE revision.revisionId IS UNIQUE",
  "CREATE CONSTRAINT movement_concept_identity IF NOT EXISTS FOR (concept:MovementConcept) REQUIRE (concept.graphRevisionId, concept.conceptId) IS UNIQUE",
  "CREATE CONSTRAINT movement_node_assertion_identity IF NOT EXISTS FOR (concept:MovementConcept) REQUIRE (concept.graphRevisionId, concept.assertionId) IS UNIQUE",
  "CREATE CONSTRAINT movement_edge_assertion_identity IF NOT EXISTS FOR ()-[edge:MOVEMENT_EDGE]-() REQUIRE (edge.graphRevisionId, edge.assertionId) IS UNIQUE",
  "CREATE CONSTRAINT movement_publication_attempt_identity IF NOT EXISTS FOR (attempt:PublicationAttempt) REQUIRE attempt.attemptId IS UNIQUE",
  "CREATE CONSTRAINT movement_revision_seal_identity IF NOT EXISTS FOR (seal:RevisionSeal) REQUIRE seal.sealId IS UNIQUE",
  "CREATE CONSTRAINT movement_activation_event_identity IF NOT EXISTS FOR (event:ActivationEvent) REQUIRE event.eventId IS UNIQUE",
  "CREATE INDEX movement_concept_kind IF NOT EXISTS FOR (concept:MovementConcept) ON (concept.graphRevisionId, concept.kind)",
  "CREATE INDEX movement_attempt_revision IF NOT EXISTS FOR (attempt:PublicationAttempt) ON (attempt.graphRevisionId)",
  "CREATE INDEX movement_activation_revision IF NOT EXISTS FOR (event:ActivationEvent) ON (event.graphRevisionId)",
]);

export async function setupMovementNeo4jSchema(client: Neo4jClient): Promise<void> {
  await client.executeWrite(async (transaction) => {
    for (const query of MOVEMENT_NEO4J_SCHEMA_QUERIES) await transaction.run(query);
  });
}
