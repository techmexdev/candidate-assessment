# Ontology grounding model

The application has its own stable local vocabulary. External ontologies help a reviewer say what a local term means. They do not own application IDs, and they do not create safety rules.

> Safety notice: the mappings, clinical rules, and examples in this repository are synthetic take-home artifacts. This graph is not clinically validated medical guidance.

## Why the model is bounded

A large ontology import would add thousands of classes that this product does not use. It would also add licensing, release, deprecation, and traversal risks. This release grounds only the condition and anatomy concepts used by the first safety paths. All catalog concepts still have stable local IDs.

The rule is simple:

- Use a reviewed external concept when its identifier, meaning, release, and terms are clear.
- Keep a concept `local-only` when no safe external match has been verified.
- Never invent a class IRI from a label.
- Never infer a clinical rule from terminology membership or graph hierarchy.

## SNOMED CT role

SNOMED CT supplies stable references for the safety-critical anatomy and condition subset. The checked-in mapping metadata comes from the SNOMED CT Global Patient Set review and names release `SNOMEDCT_US 2025_09_01`.

The eight reviewed mappings are:

| Local ID | SNOMED CT code | Preferred term | SKOS relation |
|---|---:|---|---|
| `condition:shoulder-pain` | `45326000` | Pain of shoulder region | `closeMatch` |
| `condition:knee-pain` | `1003722009` | Pain of knee region | `closeMatch` |
| `condition:patellofemoral-pain-syndrome` | `430725003` | Patellofemoral stress syndrome | `closeMatch` |
| `condition:low-back-pain` | `279039007` | Low back pain | `exactMatch` |
| `joint:shoulder` | `31398001` | Joint structure of shoulder region | `closeMatch` |
| `joint:knee` | `49076000` | Knee joint structure | `exactMatch` |
| `joint:patellofemoral` | `129160003` | Structure of patellofemoral joint | `exactMatch` |
| `body-region:lumbar-back` | `52612000` | Structure of lumbar region of back | `exactMatch` |

SNOMED CT is terminology grounding, not clinical evidence. A `maps-to` edge can help resolve “knee pain” to `condition:knee-pain`. Only a reviewed `clinical-rule`, with its own `supported-by` evidence path, may produce a contraindication, caution, or down-rank.

The project does not import the SNOMED CT hierarchy. The local `part-of` hierarchy is reviewed separately. This prevents an external hierarchy update from silently changing application safety behavior.

## OPE role and `local-only`

OPE is a useful curator lead for exercise, movement, muscle, and equipment language. The reviewed BioPortal entry identifies alpha release `0.0.1`, but it does not state clear ontology license metadata and does not provide enough verified meaning for this release.

For that reason, OPE records in `data/movement-ontology-mappings.json` are `local-only` verification records. They record that a curator looked for a match. They contain no guessed OPE code, class IRI, or embedded OPE content. They do not create an `ontology-concept` node or `maps-to` edge.

This is not missing data hidden by the system. Resolver and explanation output keep the grounding status visible. A local concept can still be used safely when the project rule is reviewed and all required safety-critical condition and anatomy mappings exist.

OPE is not a clinical safety authority.

## COPPER boundary

COPPER describes goals, barriers, context, and behavior-change plans. Those ideas can belong in the Member Context graph when behavior-change planning is implemented.

COPPER is excluded from the Movement and Clinical graph. It cannot be a safety authority, clinical evidence source, or exercise mapping in this revision.

## SKOS mapping policy

SKOS gives the project a small, explicit mapping vocabulary. The graph accepts four relations:

| Relation | Use it when | Do not assume |
|---|---|---|
| `exactMatch` | The local and external concepts have the same reviewed scope for this revision. | It is not `owl:sameAs`, and it does not merge IDs. |
| `closeMatch` | The concepts are strongly aligned but differ in wording or scope. | It is not exact equivalence. |
| `broadMatch` | The external target is broader than the local concept. | The broader descendants are not imported or made safe. |
| `narrowMatch` | The external target is narrower than the local concept. | The local concept does not inherit all narrow meaning. |

String similarity is not enough. A curator chooses the relation after a concept-level review. Mapping chains never create clinical rules.

## Mapping record contract

A reviewed mapping record must carry:

- local `targetConceptId` and `targetKind`;
- external ontology name, `sourceCode`, `sourceTerm`, `sourceUri`, `sourceRelease`, and external status;
- stable `mappingId`, edge `assertionId`, and external `ontologyConceptId`;
- one allowed SKOS `relation`;
- numeric `confidence`;
- a concept-specific `rationale` and scope rationale;
- `curator` and `reviewedAt`;
- `sourceArtifactDigest` plus the reviewed source ID and source revision.

A `local-only` record carries a stable verification ID, local target, ontology and release reviewed, `verificationStatus: not-verified`, review reason, curator, date, and source review. It must not carry an invented source code or URI.

Deprecation is explicit. If an external concept becomes inactive, its node status and mapping review change in a new graph revision. A resolver may show the mapping as deprecated, but a deprecated mapping cannot silently resolve as active.

## PROV-O alignment

PROV-O shapes build and decision provenance. It does not replace the application's domain edge meanings.

- `graph-revision --was-generated-by--> ingestion-activity` mirrors `prov:wasGeneratedBy`.
- `ingestion-activity --used--> evidence-source` mirrors `prov:used`.
- The immutable `graphRevisionId`, source digests, software version, input IDs, start/end time, and outcome let a reviewer audit a build.
- A separate Decision and Run record references one Movement revision and one Member Context revision. It stores the stable IDs used by the decision.

The application keeps its own stable identifiers because its lifecycle, validation rules, and bounded queries are stricter than a generic PROV-O store.

## Release and license review

Release and license decisions are versioned data in `data/movement-source-reviews.json`. A mapping is valid only when its source release and source revision match that reviewed record and its artifact digest matches the reviewed artifact.

### SNOMED CT GPS

- Source: SNOMED CT Global Patient Set, SNOMED International.
- Review state: approved for bounded mapping metadata.
- License recorded by this project: CC BY-ND 4.0.
- Required behavior: keep attribution, do not alter preferred labels, do not import hierarchy, and store only the reviewed identifiers, names, status, and mapping metadata used here.
- Review observation date: `2026-08-06`.

Attribution: SNOMED CT Global Patient Set, SNOMED International, licensed under CC BY-ND 4.0.

### OPE BioPortal entry

- Source: Ontology of Physical Exercises BioPortal entry.
- Release: `0.0.1`, marked alpha.
- Review state: citation-only because no clear license was found in the reviewed page.
- Required behavior: embed no OPE ontology content, class IDs, or guessed IRIs. Keep candidate concepts `local-only`.
- Review observation date: `2026-08-06`.

A later ontology release or license change does not mutate the current graph. A curator performs a new review and publishes a new immutable graph revision.

## Clinical evidence boundary

The checked-in clinical evidence and rules are synthetic project policy. They exist to prove deterministic graph paths, validation, precedence, substitutions, and explanations. They are not medical recommendations and do not claim validation by SNOMED International, OPE, a clinician, or a health organization.

Real clinical use would require a separate governance process, qualified clinical review, evidence appraisal, jurisdiction and license review, monitoring, and product safety validation. Until then, fail closed and use this graph only as a take-home demonstration.
