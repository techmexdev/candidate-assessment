export const MOVEMENT_CYPHER = Object.freeze({
  findRevision: `
    MATCH (revision:MovementRevision {revisionId: $revisionId})
    RETURN revision.revisionId AS revisionId, revision.canonicalDigest AS canonicalDigest,
      revision.nodeCount AS nodeCount, revision.edgeCount AS edgeCount
  `,
  createStage: `
    CREATE (revision:MovementRevision {
      revisionId: $revisionId, canonicalDigest: $canonicalDigest,
      nodeCount: $nodeCount, edgeCount: $edgeCount
    })
    CREATE (attempt:PublicationAttempt {
      attemptId: $attemptId, graphRevisionId: $revisionId, state: 'staged',
      requestedDigest: $canonicalDigest, requestedNodeCount: $nodeCount,
      requestedEdgeCount: $edgeCount, stagedAt: $stagedAt, validationErrors: []
    })
    CREATE (attempt)-[:ATTEMPTED_REVISION]->(revision)
  `,
  createNodes: `
    MATCH (revision:MovementRevision {revisionId: $revisionId})
    UNWIND $nodes AS row
    CREATE (concept:MovementConcept {
      graphRevisionId: $revisionId, conceptId: row.conceptId,
      assertionId: row.assertionId, kind: row.kind, payload: row.payload
    })
    CREATE (concept)-[:BELONGS_TO_REVISION]->(revision)
  `,
  createEdges: `
    UNWIND $edges AS row
    MATCH (source:MovementConcept {graphRevisionId: $revisionId, conceptId: row.fromConceptId})
    MATCH (target:MovementConcept {graphRevisionId: $revisionId, conceptId: row.toConceptId})
    CREATE (source)-[:MOVEMENT_EDGE {
      graphRevisionId: $revisionId, assertionId: row.assertionId,
      kind: row.kind, payload: row.payload
    }]->(target)
  `,
  readNodes: `
    MATCH (concept:MovementConcept {graphRevisionId: $revisionId})
    RETURN concept.payload AS payload
    ORDER BY concept.assertionId
    LIMIT $limit
  `,
  readEdges: `
    MATCH (:MovementConcept {graphRevisionId: $revisionId})-[edge:MOVEMENT_EDGE {graphRevisionId: $revisionId}]->(:MovementConcept {graphRevisionId: $revisionId})
    RETURN edge.payload AS payload
    ORDER BY edge.assertionId
    LIMIT $limit
  `,
  findAttempt: `
    MATCH (attempt:PublicationAttempt {attemptId: $attemptId})
    RETURN attempt.attemptId AS attemptId, attempt.graphRevisionId AS revisionId,
      attempt.state AS state, attempt.requestedDigest AS requestedDigest,
      attempt.requestedNodeCount AS requestedNodeCount,
      attempt.requestedEdgeCount AS requestedEdgeCount
  `,
  rejectAttempt: `
    MATCH (attempt:PublicationAttempt {attemptId: $attemptId})
    SET attempt.state = 'rejected', attempt.validationErrors = $validationErrors,
      attempt.validatedAt = $validatedAt
  `,
  sealRevision: `
    MATCH (attempt:PublicationAttempt {attemptId: $attemptId})-[:ATTEMPTED_REVISION]->(revision:MovementRevision {revisionId: $revisionId})
    MERGE (seal:RevisionSeal {sealId: $sealId})
    ON CREATE SET seal.graphRevisionId = $revisionId, seal.canonicalDigest = $canonicalDigest,
      seal.nodeCount = $nodeCount, seal.edgeCount = $edgeCount,
      seal.clinicalReviewApprovalId = $clinicalReviewApprovalId, seal.sealedAt = $sealedAt
    MERGE (seal)-[:SEALS_REVISION]->(revision)
    SET attempt.state = 'sealed', attempt.validatedAt = $sealedAt, attempt.validationErrors = []
    RETURN seal.sealId AS sealId
  `,
  readSealedRevision: `
    MATCH (seal:RevisionSeal)-[:SEALS_REVISION]->(revision:MovementRevision {revisionId: $revisionId})
    RETURN revision.revisionId AS revisionId, seal.canonicalDigest AS canonicalDigest,
      seal.nodeCount AS nodeCount, seal.edgeCount AS edgeCount, seal.sealId AS sealId
    LIMIT 1
  `,
  readActiveRevision: `
    MATCH (catalog:GraphCatalog {catalogId: 'movement-clinical'})
    RETURN catalog.activeRevisionId AS activeRevisionId
  `,
  activateRevision: `
    MERGE (catalog:GraphCatalog {catalogId: 'movement-clinical'})
    ON CREATE SET catalog.activeRevisionId = null, catalog.lockVersion = 0
    SET catalog.lockVersion = coalesce(catalog.lockVersion, 0) + 1
    WITH catalog, catalog.activeRevisionId AS actualRevisionId
    OPTIONAL MATCH (seal:RevisionSeal {graphRevisionId: $revisionId})-[:SEALS_REVISION]->(:MovementRevision {revisionId: $revisionId})
    RETURN actualRevisionId, seal.sealId AS sealId,
      seal.canonicalDigest AS canonicalDigest, seal.nodeCount AS nodeCount, seal.edgeCount AS edgeCount
  `,
  swapActiveRevision: `
    MATCH (catalog:GraphCatalog {catalogId: 'movement-clinical'})
    MATCH (revision:MovementRevision {revisionId: $revisionId})
    SET catalog.activeRevisionId = $revisionId
    CREATE (event:ActivationEvent {
      eventId: $eventId, graphRevisionId: $revisionId,
      priorRevisionId: $priorRevisionId, actorId: $actorId, activatedAt: $activatedAt
    })
    CREATE (event)-[:ACTIVATED_REVISION]->(revision)
  `,
  inspect: `
    OPTIONAL MATCH (catalog:GraphCatalog {catalogId: 'movement-clinical'})
    OPTIONAL MATCH (revision:MovementRevision {revisionId: $revisionId})
    OPTIONAL MATCH (attempt:PublicationAttempt {graphRevisionId: $revisionId})
    OPTIONAL MATCH (seal:RevisionSeal {graphRevisionId: $revisionId})
    RETURN catalog.activeRevisionId AS activeRevisionId, revision.revisionId AS revisionId,
      attempt.attemptId AS attemptId, attempt.state AS attemptState,
      attempt.validationErrors AS validationErrors, seal.sealId AS sealId
    ORDER BY attempt.attemptId
    LIMIT 1
  `,
  inspectCatalog: `
    OPTIONAL MATCH (catalog:GraphCatalog {catalogId: 'movement-clinical'})
    RETURN catalog.activeRevisionId AS activeRevisionId
  `,
});
