import type { Neo4jClient } from "../../src/graph/neo4j/client";

const LOCAL_NEO4J_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const CLEAR_MEMBER_CONTEXT_RELATIONSHIPS = `
  MATCH ()-[relationship]->()
  WHERE type(relationship) STARTS WITH $relationshipTypePrefix
  DELETE relationship
`;

const CLEAR_MEMBER_CONTEXT_NODES = `
  MATCH (node)
  WHERE any(label IN labels(node) WHERE label STARTS WITH $labelPrefix)
  DETACH DELETE node
`;

export function assertLocalNeo4jTestUri(uri: string): void {
  let hostname: string;
  try {
    hostname = new URL(uri).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new Error(`Member Context integration tests require a valid local Neo4j URI; received ${JSON.stringify(uri)}.`);
  }

  if (!LOCAL_NEO4J_HOSTS.has(hostname)) {
    throw new Error(`Member Context integration tests refuse destructive setup against non-local Neo4j host ${JSON.stringify(hostname)}.`);
  }
}

export async function resetMemberContextTestGraph(client: Neo4jClient, uri: string): Promise<void> {
  assertLocalNeo4jTestUri(uri);
  await client.executeWrite(async (transaction) => {
    await transaction.run(CLEAR_MEMBER_CONTEXT_RELATIONSHIPS, {
      relationshipTypePrefix: "MEMBER_CONTEXT_",
    });
    await transaction.run(CLEAR_MEMBER_CONTEXT_NODES, {
      labelPrefix: "MemberContext",
    });
  });
}
