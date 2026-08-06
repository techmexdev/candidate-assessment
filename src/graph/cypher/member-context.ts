export const MEMBER_CONTEXT_CYPHER = Object.freeze({
  findRevision: `
    MATCH (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN revision.memberId AS memberId, revision.contextRevisionId AS contextRevisionId,
      revision.canonicalDigest AS canonicalDigest, revision.nodeCount AS nodeCount,
      revision.relationshipCount AS relationshipCount,
      revision.sourceArtifactDigest AS sourceArtifactDigest
  `,
  createStage: `
    CREATE (revision:MemberContextRevision {
      memberId: $memberId, contextRevisionId: $contextRevisionId,
      canonicalDigest: $canonicalDigest, nodeCount: $nodeCount,
      relationshipCount: $relationshipCount, sourceArtifactDigest: $sourceArtifactDigest
    })
    CREATE (attempt:MemberContextPublicationAttempt {
      attemptId: $attemptId, memberId: $memberId, contextRevisionId: $contextRevisionId,
      state: 'staged', requestedDigest: $canonicalDigest,
      requestedNodeCount: $nodeCount, requestedRelationshipCount: $relationshipCount,
      stagedAt: $stagedAt, validationErrors: []
    })
    CREATE (attempt)-[:MEMBER_CONTEXT_ATTEMPTED_REVISION]->(revision)
  `,
  createNodes: `
    MATCH (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    UNWIND $nodes AS row
    CREATE (fact:MemberContextFact {
      memberId: $memberId, contextRevisionId: $contextRevisionId,
      semanticId: row.semanticId, assertionId: row.assertionId,
      kind: row.kind, recordOrder: row.recordOrder,
      temporalPrecision: row.temporalPrecision, effectiveAt: row.effectiveAt,
      effectiveOn: row.effectiveOn, sourceOrder: row.sourceOrder,
      payload: row.payload
    })
    CREATE (fact)-[:MEMBER_CONTEXT_BELONGS_TO_REVISION]->(revision)
  `,
  createRelationships: `
    UNWIND $relationships AS row
    MATCH (source:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId, semanticId: row.fromSemanticId})
    MATCH (target:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId, semanticId: row.toSemanticId})
    CREATE (source)-[:MEMBER_CONTEXT_RELATIONSHIP {
      memberId: $memberId, contextRevisionId: $contextRevisionId,
      assertionId: row.assertionId, kind: row.kind,
      recordOrder: row.recordOrder, sourceOrder: row.sourceOrder,
      payload: row.payload
    }]->(target)
  `,
  readNodes: `
    MATCH (fact:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN fact.payload AS payload
    ORDER BY fact.recordOrder, fact.semanticId
    LIMIT $limit
  `,
  readRelationships: `
    MATCH (:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId})
      -[relationship:MEMBER_CONTEXT_RELATIONSHIP {memberId: $memberId, contextRevisionId: $contextRevisionId}]->
      (:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN relationship.payload AS payload
    ORDER BY relationship.recordOrder, relationship.assertionId
    LIMIT $limit
  `,
  findAttempt: `
    MATCH (attempt:MemberContextPublicationAttempt {attemptId: $attemptId})
    RETURN attempt.attemptId AS attemptId, attempt.memberId AS memberId,
      attempt.contextRevisionId AS contextRevisionId, attempt.state AS state,
      attempt.requestedDigest AS requestedDigest,
      attempt.requestedNodeCount AS requestedNodeCount,
      attempt.requestedRelationshipCount AS requestedRelationshipCount
  `,
  rejectAttempt: `
    MATCH (attempt:MemberContextPublicationAttempt {attemptId: $attemptId})
    SET attempt.state = 'rejected', attempt.validationErrors = $validationErrors,
      attempt.validatedAt = $validatedAt
  `,
  sealRevision: `
    MATCH (attempt:MemberContextPublicationAttempt {attemptId: $attemptId})
      -[:MEMBER_CONTEXT_ATTEMPTED_REVISION]->
      (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    MERGE (seal:MemberContextRevisionSeal {sealId: $sealId})
    ON CREATE SET seal.memberId = $memberId, seal.contextRevisionId = $contextRevisionId,
      seal.canonicalDigest = $canonicalDigest, seal.nodeCount = $nodeCount,
      seal.relationshipCount = $relationshipCount, seal.sealedAt = $sealedAt
    MERGE (seal)-[:MEMBER_CONTEXT_SEALS_REVISION]->(revision)
    SET attempt.state = 'sealed', attempt.validatedAt = $sealedAt,
      attempt.validationErrors = []
    RETURN seal.sealId AS sealId
  `,
  readSealedRevision: `
    MATCH (seal:MemberContextRevisionSeal {memberId: $memberId, contextRevisionId: $contextRevisionId})
      -[:MEMBER_CONTEXT_SEALS_REVISION]->
      (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN seal.canonicalDigest AS canonicalDigest, seal.nodeCount AS nodeCount,
      seal.relationshipCount AS relationshipCount, seal.sealId AS sealId
    LIMIT 1
  `,
  readActiveRevision: `
    MATCH (catalog:MemberContextCatalog {memberId: $memberId})
    RETURN catalog.activeRevisionId AS activeRevisionId
  `,
  activateRevision: `
    MERGE (catalog:MemberContextCatalog {memberId: $memberId})
    ON CREATE SET catalog.activeRevisionId = null, catalog.lockVersion = 0
    SET catalog.lockVersion = coalesce(catalog.lockVersion, 0) + 1
    WITH catalog, catalog.activeRevisionId AS actualRevisionId
    OPTIONAL MATCH (seal:MemberContextRevisionSeal {memberId: $memberId, contextRevisionId: $contextRevisionId})
      -[:MEMBER_CONTEXT_SEALS_REVISION]->
      (:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN actualRevisionId, seal.sealId AS sealId,
      seal.canonicalDigest AS canonicalDigest, seal.nodeCount AS nodeCount,
      seal.relationshipCount AS relationshipCount
  `,
  swapActiveRevision: `
    MATCH (catalog:MemberContextCatalog {memberId: $memberId})
    MATCH (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    SET catalog.activeRevisionId = $contextRevisionId
    CREATE (event:MemberContextActivationEvent {
      eventId: $eventId, memberId: $memberId, contextRevisionId: $contextRevisionId,
      priorRevisionId: $priorRevisionId, actorId: $actorId, activatedAt: $activatedAt
    })
    CREATE (event)-[:MEMBER_CONTEXT_ACTIVATED_REVISION]->(revision)
  `,
  inspect: `
    OPTIONAL MATCH (catalog:MemberContextCatalog {memberId: $memberId})
    OPTIONAL MATCH (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
    OPTIONAL MATCH (attempt:MemberContextPublicationAttempt {memberId: $memberId, contextRevisionId: $contextRevisionId})
    OPTIONAL MATCH (seal:MemberContextRevisionSeal {memberId: $memberId, contextRevisionId: $contextRevisionId})
    RETURN catalog.activeRevisionId AS activeRevisionId,
      revision.contextRevisionId AS contextRevisionId,
      attempt.attemptId AS attemptId, attempt.state AS attemptState,
      attempt.validationErrors AS validationErrors, seal.sealId AS sealId
    ORDER BY attempt.attemptId
    LIMIT 1
  `,
  inspectCatalog: `
    OPTIONAL MATCH (catalog:MemberContextCatalog {memberId: $memberId})
    RETURN catalog.activeRevisionId AS activeRevisionId
  `,
});
