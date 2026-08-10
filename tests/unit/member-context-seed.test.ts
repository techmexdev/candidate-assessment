import { describe, expect, it } from "vitest";
import { memberContextNeo4jClientConfig, runAllMemberContextSeeds } from "../../scripts/seed-member-context";

describe("member context seed targets", () => {
  it("validates every tracked roster member without database writes", async () => {
    const result = await runAllMemberContextSeeds({ mode: "dry-run" });

    expect(result.outcome).toBe("validated");
    expect(result.reports).toHaveLength(3);
    expect(result.reports.map((report) => report.memberId)).toEqual([
      "mbr_01HX9JORDAN",
      "mbr_02HX9AVERY",
      "mbr_03HX9MORGAN",
    ]);
    expect(result.reports.map((report) => report.sourcePath)).toEqual([
      "data/member-context.json",
      "data/member-context-avery.json",
      "data/member-context-morgan.json",
    ]);
    expect(result.reports.every((report) => report.nodeCount > 0 && report.relationshipCount > 0)).toBe(true);
  });

  it("maps Railway environment values explicitly instead of falling back to localhost", () => {
    expect(memberContextNeo4jClientConfig({
      NODE_ENV: "production",
      AXON_RUNTIME_PROFILE: "railway-demo",
      NEO4J_ALLOW_INSECURE_RAILWAY: "1",
      NEO4J_PRIVATE_DOMAIN: "neo4j.railway.internal",
      NEO4J_URI: "bolt://neo4j.railway.internal:7687",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "Q7v!pR2#nL8@xZ4$",
      NEO4J_DATABASE: "neo4j",
    })).toMatchObject({
      uri: "bolt://neo4j.railway.internal:7687",
      runtimeProfile: "railway-demo",
      allowInsecureRailway: true,
      expectedPrivateDomain: "neo4j.railway.internal",
    });
  });
});
