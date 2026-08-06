import { createHash } from "node:crypto";
import conceptMappings from "../../../data/member-context-concept-mappings.json";
import type {
  AssertionClassification,
  AssertionTemporal,
  DomainConceptReference,
  JsonValue,
  MemberContextDocumentInput,
  MemberContextGraphNode,
  MemberContextGraphRelationship,
  MemberContextGraphSnapshot,
  MemberChatMessage,
  MemberContextSnapshot,
  MemberEvidence,
  EvidenceKind,
} from "../../domain/contracts/member-context";
import {
  MEMBER_CONTEXT_COMPILER_VERSION,
  MEMBER_CONTEXT_SCHEMA_VERSION,
  canonicalJson,
  contextRevisionId,
  deepFreeze,
  sha256,
  sourceArtifactDigest,
} from "../revisions/member-context";
import {
  MemberContextValidationError,
  validateMemberContextGraph,
  validateMemberContextSource,
} from "../validation/member-context";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function revisionFor(document: MemberContextDocumentInput, datasetRevision: string) {
  return `context-${createHash("sha256").update(`${datasetRevision}:${stableJson(document)}`).digest("hex").slice(0, 16)}`;
}

function asJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asJson(child)]));
  return String(value);
}

function makeEvidence(
  memberId: string,
  sourceRevision: string,
  kind: EvidenceKind,
  sourcePath: string,
  occurredAt: string,
  value: unknown,
): MemberEvidence {
  return {
    evidenceId: `${memberId}:${kind}:${sourcePath}`,
    memberId,
    kind,
    occurredAt,
    recordedAt: occurredAt,
    sourcePath,
    sourceRevision,
    synthetic: true,
    value: asJson(value),
  };
}

function normalizeChatHistory(messages: MemberContextDocumentInput["chat_history"]): MemberChatMessage[] {
  return messages.map((message) => {
    if (message.from !== "member" && message.from !== "coach") throw new Error(`Unsupported chat author: ${message.from}`);
    const attachments = (message.attachments ?? []).map((attachment) => {
      if (attachment.type !== "image") throw new Error(`Unsupported chat attachment: ${attachment.type}`);
      return { type: "image" as const, caption: attachment.caption };
    });
    return { ts: message.ts, from: message.from, text: message.text, ...(attachments.length > 0 ? { attachments } : {}) };
  });
}

export function buildMemberContextSnapshot(document: MemberContextDocumentInput, datasetRevision = "dataset-v1"): MemberContextSnapshot {
  const { profile } = document;
  const contextRevision = revisionFor(document, datasetRevision);
  const sourceRevision = datasetRevision;
  const chatHistory = normalizeChatHistory(document.chat_history);
  const evidence: MemberEvidence[] = [
    makeEvidence(profile.id, sourceRevision, "profile", "profile", profile.member_since, profile),
    ...document.goals.map((goal) => makeEvidence(profile.id, sourceRevision, "goal", `goals.${goal.id}`, goal.target_date ?? profile.member_since, goal)),
    makeEvidence(profile.id, sourceRevision, "preference", "preferences", profile.member_since, document.preferences),
    ...document.equipment_available.map((item, index) => makeEvidence(profile.id, sourceRevision, "equipment", `equipment_available.${index}`, profile.member_since, item)),
    ...document.injuries.map((injury) => makeEvidence(profile.id, sourceRevision, "injury", `injuries.${injury.id}`, injury.since, injury)),
    ...document.workout_history.map((workout) => makeEvidence(profile.id, sourceRevision, "workout", `workout_history.${workout.date}`, workout.date, workout)),
    ...document.adherence.weekly_completion_pct.map((week) => makeEvidence(profile.id, sourceRevision, "adherence", `adherence.weekly_completion_pct.${week.week_of}`, week.week_of, week)),
    makeEvidence(profile.id, sourceRevision, "biomarker", "biomarkers", document.coach_brief.generated_for, document.biomarkers),
    ...Object.entries(document.labs).map(([panel, value]) => makeEvidence(profile.id, sourceRevision, "lab", `labs.${panel}`, String(value.date ?? document.coach_brief.generated_for), value)),
    ...chatHistory.map((message, index) => makeEvidence(profile.id, sourceRevision, "message", `chat_history.${index}`, message.ts, message)),
    ...chatHistory.flatMap((message, messageIndex) => (message.attachments ?? []).map((attachment, attachmentIndex) => makeEvidence(profile.id, sourceRevision, "image", `chat_history.${messageIndex}.attachments.${attachmentIndex}`, message.ts, attachment))),
    ...document.coach_brief.morning_tasks.map((task, index) => makeEvidence(profile.id, sourceRevision, "coach-task", `coach_brief.morning_tasks.${index}`, document.coach_brief.generated_for, task)),
    makeEvidence(profile.id, sourceRevision, "churn-signal", "coach_brief.churn_risk", document.coach_brief.generated_for, document.coach_brief.churn_risk),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.evidenceId.localeCompare(right.evidenceId));

  return {
    memberId: profile.id,
    coachId: profile.coach_id,
    datasetRevision,
    contextRevision,
    asOf: document.coach_brief.generated_for,
    timezone: profile.timezone,
    synthetic: true,
    profile,
    goals: document.goals,
    preferences: document.preferences,
    equipmentAvailable: document.equipment_available,
    injuries: document.injuries,
    workoutHistory: document.workout_history,
    adherence: document.adherence,
    biomarkers: document.biomarkers,
    labs: document.labs,
    chatHistory,
    coachBrief: document.coach_brief,
    evidence,
  };
}

const mappingArtifactDigest = sha256(canonicalJson(conceptMappings));

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function identityHash(value: unknown): string {
  return sha256(canonicalJson(value)).slice("sha256:".length, "sha256:".length + 16);
}

function unresolved(originalText: string, reason: "no-deterministic-match" | "not-reviewed" | "not-applicable" = "not-reviewed"): DomainConceptReference {
  return { state: "unresolved", originalText, reason };
}

function reviewedMapping(sourceKind: string, sourceText: string): DomainConceptReference | undefined {
  const record = conceptMappings.records.find((candidate) => (
    candidate.status === "reviewed" && candidate.source_kind === sourceKind && candidate.source_text === sourceText
  ));
  if (!record) return undefined;
  return {
    state: "reviewed",
    graph: "movement-clinical",
    stableConceptId: record.stable_concept_id as Extract<DomainConceptReference, { state: "reviewed"; graph: "movement-clinical" }>["stableConceptId"],
    reviewedBy: conceptMappings.reviewed_by,
    reviewedAt: conceptMappings.reviewed_at,
    sourceArtifactDigest: mappingArtifactDigest,
  };
}

function assertionId(contextRevision: string, semanticId: string, locator: string, role: string): string {
  return `assertion:${identityHash({ contextRevision, locator, role, semanticId })}`;
}

type AssertionBase = {
  semanticId: string;
  assertionId: string;
  memberId: string;
  contextRevisionId: string;
  source: { locator: string; artifactDigest: string };
  classification: AssertionClassification;
  temporal: AssertionTemporal;
  synthetic: true;
};

function assertionBase(
  memberId: string,
  contextRevision: string,
  artifactDigest: string,
  semanticId: string,
  locator: string,
  classification: AssertionClassification,
  temporal: AssertionTemporal,
  role: string,
): AssertionBase {
  return {
    semanticId,
    assertionId: assertionId(contextRevision, semanticId, locator, role),
    memberId,
    contextRevisionId: contextRevision,
    source: { locator, artifactDigest },
    classification,
    temporal,
    synthetic: true,
  };
}

type AddNode = <T extends MemberContextGraphNode>(node: T) => T;

function relationship(
  memberId: string,
  contextRevision: string,
  artifactDigest: string,
  kind: MemberContextGraphRelationship["kind"],
  from: MemberContextGraphNode,
  to: MemberContextGraphNode,
  locator: string,
  classification: AssertionClassification,
  temporal: AssertionTemporal,
  sourceOrder?: number,
): MemberContextGraphRelationship {
  const semanticId = `relationship:${kind.toLowerCase()}:${from.semanticId}->${to.semanticId}`;
  return {
    kind,
    ...assertionBase(memberId, contextRevision, artifactDigest, semanticId, locator, classification, temporal, "relationship"),
    fromSemanticId: from.semanticId,
    fromKind: from.kind,
    toSemanticId: to.semanticId,
    toKind: to.kind,
    ...(sourceOrder === undefined ? {} : { sourceOrder }),
  } as unknown as MemberContextGraphRelationship;
}

const labDefinitions = {
  blood_panel: {
    panelType: "blood" as const,
    label: "Blood panel",
    measurements: [
      ["ldl_mg_dl", "ldl-cholesterol", "milligram/deciliter"],
      ["hdl_mg_dl", "hdl-cholesterol", "milligram/deciliter"],
      ["triglycerides_mg_dl", "triglycerides", "milligram/deciliter"],
      ["hba1c_pct", "hemoglobin-a1c", "percent"],
      ["vitamin_d_ng_ml", "vitamin-d", "nanogram/milliliter"],
      ["ferritin_ng_ml", "ferritin", "nanogram/milliliter"],
      ["crp_mg_l", "c-reactive-protein", "milligram/liter"],
    ] as const,
  },
  dexa_scan: {
    panelType: "dexa" as const,
    label: "DEXA scan",
    measurements: [
      ["body_fat_pct", "body-fat", "percent"],
      ["lean_mass_kg", "lean-mass", "kilogram"],
      ["fat_mass_kg", "fat-mass", "kilogram"],
      ["bone_density_z_score", "bone-density-z-score", "z-score"],
      ["visceral_fat_cm2", "visceral-fat-area", "square-centimeter"],
    ] as const,
  },
} as const;

export function compileMemberContextGraph(input: MemberContextDocumentInput): MemberContextGraphSnapshot {
  const sourceValidation = validateMemberContextSource(input);
  if (!sourceValidation.valid) throw new MemberContextValidationError(sourceValidation.errors);

  const document = structuredClone(input);
  const artifactDigest = sourceArtifactDigest(document);
  const revisionId = contextRevisionId(artifactDigest, mappingArtifactDigest);
  const memberId = document.profile.id;
  const memberSemanticId = `member:${memberId}`;
  const coachSemanticId = `coach:${document.profile.coach_id}`;
  const nodes: MemberContextGraphNode[] = [];
  const relationships: MemberContextGraphRelationship[] = [];
  const addNode: AddNode = (node) => { nodes.push(node); return node; };
  const addRelationship = (
    kind: MemberContextGraphRelationship["kind"],
    from: MemberContextGraphNode,
    to: MemberContextGraphNode,
    locator: string,
    classification: AssertionClassification,
    temporal: AssertionTemporal,
    sourceOrder?: number,
  ) => relationships.push(relationship(memberId, revisionId, artifactDigest, kind, from, to, locator, classification, temporal, sourceOrder));

  const member = addNode({ kind: "member", semanticId: memberSemanticId, sourceId: memberId, synthetic: true });
  const coach = addNode({ kind: "coach", semanticId: coachSemanticId, sourceId: document.profile.coach_id, synthetic: true });
  const sourceArtifact = addNode({
    kind: "source-artifact",
    semanticId: `source-artifact:${artifactDigest}`,
    artifactDigest,
    sourceLocator: "data/member-context.json",
    mediaType: "application/json",
    synthetic: true,
  });
  const revision = addNode({
    kind: "member-context-revision",
    semanticId: revisionId,
    memberId,
    sourceArtifactDigest: artifactDigest,
    schemaVersion: MEMBER_CONTEXT_SCHEMA_VERSION,
    compilerVersion: MEMBER_CONTEXT_COMPILER_VERSION,
    validationResult: "valid",
    synthetic: true,
  });
  const ingestion = addNode({
    kind: "ingestion-activity",
    semanticId: `ingestion-activity:${revisionId}`,
    softwareVersion: MEMBER_CONTEXT_COMPILER_VERSION,
    startedAt: "unknown",
    endedAt: "unknown",
    outcome: "succeeded",
    synthetic: true,
  });

  addRelationship("COACHES", coach, member, "/profile/coach_id", "source-statement", { precision: "unknown" });

  const profile = addNode({
    kind: "member-profile",
    ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:profile`, "/profile", "source-statement", { precision: "unknown" }, "node"),
    name: document.profile.name,
    age: document.profile.age,
    sex: document.profile.sex,
    heightCm: document.profile.height_cm,
    weightKg: document.profile.weight_kg,
    timezone: document.profile.timezone,
    memberSince: document.profile.member_since,
    tier: document.profile.tier,
  });
  addRelationship("HAS_PROFILE", member, profile, "/profile", "source-statement", profile.temporal);

  for (const goal of document.goals) {
    const locator = `/goals/${goal.id}`;
    const node = addNode({
      kind: "goal",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:goal:${goal.id}`, locator, "source-statement", { precision: "unknown" }, "node"),
      text: goal.text,
      priority: goal.priority,
      targetDate: goal.target_date,
      domainReference: unresolved(goal.text, "not-applicable"),
    });
    addRelationship("PURSUES", member, node, locator, "source-statement", node.temporal);
  }

  const preference = addNode({
    kind: "preference",
    ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:preference`, "/preferences", "source-statement", { precision: "unknown" }, "node"),
    preferredSessionMinutes: document.preferences.preferred_session_minutes,
    trainingDaysPerWeek: document.preferences.training_days_per_week,
    preferredDays: [...document.preferences.preferred_days],
    dislikes: [...document.preferences.dislikes],
    notes: document.preferences.notes,
    domainReferences: document.preferences.dislikes.map((text) => unresolved(text)),
  });
  addRelationship("HAS_PREFERENCE", member, preference, "/preferences", "source-statement", preference.temporal);

  for (const label of [...document.equipment_available].sort((left, right) => left.localeCompare(right))) {
    const locator = `/equipment_available/${slug(label)}`;
    const node = addNode({
      kind: "equipment-availability",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:equipment:${slug(label)}`, locator, "source-statement", { precision: "unknown" }, "node"),
      originalLabel: label,
      available: true,
      domainReference: reviewedMapping("equipment", label) ?? unresolved(label),
    });
    addRelationship("HAS_EQUIPMENT", member, node, locator, "source-statement", node.temporal);
  }

  for (const injury of document.injuries) {
    const locator = `/injuries/${injury.id}`;
    const references = [reviewedMapping("injury-joint", injury.joint) ?? unresolved(injury.joint)];
    if (injury.notes.toLocaleLowerCase().includes("patellofemoral pain")) references.push(reviewedMapping("injury-condition", "Patellofemoral pain") ?? unresolved("Patellofemoral pain"));
    const node = addNode({
      kind: "injury-episode",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:injury:${injury.id}`, locator, "source-statement", { precision: "date", effectiveOn: injury.since }, "node"),
      region: injury.region,
      joint: injury.joint,
      status: injury.status,
      severity: injury.severity,
      since: injury.since,
      notes: injury.notes,
      domainReferences: references,
    });
    addRelationship("HAS_INJURY", member, node, locator, "source-statement", node.temporal);
  }

  const incompleteWorkouts: MemberContextGraphNode[] = [];
  for (const [workoutOrder, workout] of document.workout_history.entries()) {
    const intrinsic = `${workout.date}:${slug(workout.title)}`;
    const locator = `/workout_history/${intrinsic}`;
    const node = addNode({
      kind: "workout-session",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:workout:${intrinsic}`, locator, "source-statement", { precision: "date", effectiveOn: workout.date }, "node"),
      title: workout.title,
      planned: workout.planned,
      completed: workout.completed,
      durationMinutes: workout.duration_min,
      rpe: workout.rpe,
      sourceOrder: workoutOrder,
    });
    if (!workout.completed) incompleteWorkouts.push(node);
    addRelationship("HAS_WORKOUT", member, node, locator, "source-statement", node.temporal, workoutOrder);
    for (const [exerciseOrder, originalText] of workout.exercises.entries()) {
      const exerciseLocator = `${locator}/exercises/${identityHash(originalText)}`;
      const mention = addNode({
        kind: "exercise-mention",
        ...assertionBase(memberId, revisionId, artifactDigest, `${node.semanticId}:exercise:${identityHash(originalText.toLocaleLowerCase())}`, exerciseLocator, "source-statement", node.temporal, "node"),
        originalText,
        sourceOrder: exerciseOrder,
        domainReference: unresolved(originalText),
      });
      addRelationship("MENTIONS_EXERCISE", node, mention, exerciseLocator, "source-statement", node.temporal, exerciseOrder);
    }
  }

  const adherenceNodes: MemberContextGraphNode[] = [];
  for (const [sourceOrder, point] of document.adherence.weekly_completion_pct.entries()) {
    const locator = `/adherence/weekly_completion_pct/${point.week_of}`;
    const node = addNode({
      kind: "observation",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:observation:adherence:${point.week_of}`, locator, "observation", { precision: "date", effectiveOn: point.week_of }, "node"),
      metric: "weekly-workout-completion",
      value: point.pct,
      unit: "percent",
      sourceOrder,
    });
    adherenceNodes.push(node);
    addRelationship("HAS_OBSERVATION", member, node, locator, "observation", node.temporal, sourceOrder);
  }
  const adherenceTrend = addNode({
    kind: "observation",
    ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:observation:adherence-trend`, "/adherence/trend", "source-statement", { precision: "unknown" }, "node"),
    metric: "adherence-trend",
    value: document.adherence.trend,
    unit: "category",
    sourceOrder: 0,
  });
  addRelationship("HAS_OBSERVATION", member, adherenceTrend, "/adherence/trend", "source-statement", adherenceTrend.temporal);

  const observation = (
    metric: string,
    value: string | number | boolean | null,
    unit: string,
    locator: string,
    temporal: AssertionTemporal,
    sourceOrder: number,
    semanticSuffix: string,
  ) => {
    const node = addNode({
      kind: "observation",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:observation:${semanticSuffix}`, locator, "observation", temporal, "node"),
      metric,
      value,
      unit,
      sourceOrder,
    });
    addRelationship("HAS_OBSERVATION", member, node, locator, "observation", temporal, sourceOrder);
    return node;
  };
  observation("resting-heart-rate", document.biomarkers.resting_hr_bpm, "beats/minute", "/biomarkers/resting_hr_bpm", { precision: "unknown" }, 0, "resting-heart-rate");
  observation("heart-rate-variability", document.biomarkers.hrv_ms, "millisecond", "/biomarkers/hrv_ms", { precision: "unknown" }, 0, "heart-rate-variability");
  const sleepOccurrences = new Map<number, number>();
  for (const [sourceOrder, value] of document.biomarkers.sleep_hours_last_7_days.entries()) {
    const occurrence = sleepOccurrences.get(value) ?? 0;
    sleepOccurrences.set(value, occurrence + 1);
    const identity = `${identityHash(value)}:${occurrence}`;
    observation("sleep-hours", value, "hour", `/biomarkers/sleep_hours_last_7_days/${identity}`, { precision: "relative-order", sourceOrder }, sourceOrder, `sleep-hours:last-7-days:${identity}`);
  }
  for (const [sourceOrder, point] of document.biomarkers.weight_trend_kg.entries()) {
    observation("body-weight", point.kg, "kilogram", `/biomarkers/weight_trend_kg/${point.date}`, { precision: "date", effectiveOn: point.date }, sourceOrder, `body-weight:${point.date}`);
  }

  for (const [panelOrder, panelKey] of (Object.keys(labDefinitions) as (keyof typeof labDefinitions)[]).entries()) {
    const definition = labDefinitions[panelKey];
    const sourcePanel = document.labs[panelKey];
    const panelLocator = `/labs/${panelKey}`;
    const panel = addNode({
      kind: "lab-panel",
      ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:lab-panel:${panelKey}:${String(sourcePanel.date)}`, panelLocator, "source-statement", { precision: "date", effectiveOn: String(sourcePanel.date) }, "node"),
      panelType: definition.panelType,
      label: definition.label,
      sourceOrder: panelOrder,
    });
    addRelationship("HAS_PANEL", member, panel, panelLocator, "source-statement", panel.temporal, panelOrder);
    for (const [sourceOrder, [field, metric, unit]] of definition.measurements.entries()) {
      const locator = `${panelLocator}/${field}`;
      const node = addNode({
        kind: "observation",
        ...assertionBase(memberId, revisionId, artifactDigest, `${panel.semanticId}:measurement:${metric}`, locator, "observation", panel.temporal, "node"),
        metric,
        value: sourcePanel[field] as number,
        unit,
        sourceOrder,
      });
      addRelationship("CONTAINS_MEASUREMENT", panel, node, locator, "observation", panel.temporal, sourceOrder);
    }
  }

  const conversation = addNode({
    kind: "conversation",
    ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:conversation:${coachSemanticId}`, "/chat_history", "source-statement", { precision: "unknown" }, "node"),
    participantSemanticIds: [memberSemanticId, coachSemanticId].sort(),
  });
  addRelationship("HAS_CONVERSATION", member, conversation, "/chat_history", "source-statement", conversation.temporal);
  const messageNodes: MemberContextGraphNode[] = [];
  for (const [messageOrder, message] of document.chat_history.entries()) {
    const senderRole = message.from as "member" | "coach";
    const messageIdentity = identityHash({ from: message.from, text: message.text, ts: message.ts });
    const locator = `/chat_history/${message.ts}:${messageIdentity}`;
    const temporal = { precision: "exact-timestamp", effectiveAt: message.ts } as const;
    const node = addNode({
      kind: "message",
      ...assertionBase(memberId, revisionId, artifactDigest, `${conversation.semanticId}:message:${messageIdentity}`, locator, "source-statement", temporal, "node"),
      senderRole,
      text: message.text,
      sourceOrder: messageOrder,
    });
    messageNodes.push(node);
    addRelationship("CONTAINS_MESSAGE", conversation, node, locator, "source-statement", temporal, messageOrder);
    addRelationship("SENT_BY", node, senderRole === "member" ? member : coach, `${locator}/from`, "source-statement", temporal);
    for (const [attachmentOrder, attachment] of (message.attachments ?? []).entries()) {
      const attachmentIdentity = identityHash({ caption: attachment.caption, type: attachment.type });
      const attachmentLocator = `${locator}/attachments/${attachmentIdentity}`;
      const attachmentNode = addNode({
        kind: "media-attachment",
        ...assertionBase(memberId, revisionId, artifactDigest, `${node.semanticId}:attachment:${attachmentIdentity}`, attachmentLocator, "source-statement", temporal, "node"),
        mediaType: attachment.type,
        caption: attachment.caption,
        sourceOrder: attachmentOrder,
        assetStatus: "metadata-only",
        analysisStatus: "not-analyzed",
      });
      addRelationship("HAS_ATTACHMENT", node, attachmentNode, attachmentLocator, "source-statement", temporal, attachmentOrder);
    }
  }

  const briefLocator = `/coach_brief/${document.coach_brief.generated_for}`;
  const brief = addNode({
    kind: "coach-brief",
    ...assertionBase(memberId, revisionId, artifactDigest, `${memberSemanticId}:coach-brief:${document.coach_brief.generated_for}`, briefLocator, "source-statement", { precision: "date", effectiveOn: document.coach_brief.generated_for }, "node"),
    generatedFor: document.coach_brief.generated_for,
  });
  addRelationship("HAS_BRIEF", member, brief, briefLocator, "source-statement", brief.temporal);
  for (const [taskOrder, task] of document.coach_brief.morning_tasks.entries()) {
    const taskIdentity = identityHash({ text: task.text, type: task.type });
    const locator = `${briefLocator}/morning_tasks/${taskIdentity}`;
    const node = addNode({
      kind: "coach-task",
      ...assertionBase(memberId, revisionId, artifactDigest, `${brief.semanticId}:task:${taskIdentity}`, locator, "source-statement", brief.temporal, "node"),
      taskType: task.type,
      text: task.text,
      sourceOrder: taskOrder,
    });
    addRelationship("HAS_TASK", brief, node, locator, "source-statement", brief.temporal, taskOrder);
  }

  const assessmentLocator = `${briefLocator}/churn_risk`;
  const assessment = addNode({
    kind: "churn-assessment",
    ...assertionBase(memberId, revisionId, artifactDigest, `${brief.semanticId}:churn-assessment`, assessmentLocator, "source-provided-assessment", brief.temporal, "node"),
    level: document.coach_brief.churn_risk.level,
  });
  addRelationship("HAS_ASSESSMENT", brief, assessment, assessmentLocator, "source-provided-assessment", brief.temporal);
  for (const [reasonOrder, text] of document.coach_brief.churn_risk.reasons.entries()) {
    const reasonIdentity = identityHash(text.toLocaleLowerCase());
    const locator = `${assessmentLocator}/reasons/${reasonIdentity}`;
    const isLoginReason = text.toLocaleLowerCase().includes("login frequency");
    const reason = addNode({
      kind: "churn-reason",
      ...assertionBase(memberId, revisionId, artifactDigest, `${assessment.semanticId}:reason:${reasonIdentity}`, locator, "source-provided-assessment", brief.temporal, "node"),
      text,
      sourceOrder: reasonOrder,
      basisStatus: isLoginReason ? "unsupported-source" : "supported",
    });
    addRelationship("HAS_REASON", assessment, reason, locator, "source-provided-assessment", brief.temporal, reasonOrder);
    addRelationship("SUPPORTED_BY", assessment, reason, locator, "source-provided-assessment", brief.temporal, reasonOrder);
    if (text.startsWith("Weekly adherence")) for (const evidence of adherenceNodes) addRelationship("SUPPORTED_BY", reason, evidence, locator, "source-provided-assessment", brief.temporal);
    if (text.startsWith("One skipped session")) {
      for (const evidence of incompleteWorkouts) addRelationship("SUPPORTED_BY", reason, evidence, locator, "source-provided-assessment", brief.temporal);
      for (const evidence of messageNodes.filter((candidate) => candidate.kind === "message" && candidate.text.toLocaleLowerCase().includes("wiped"))) addRelationship("SUPPORTED_BY", reason, evidence, locator, "source-provided-assessment", brief.temporal);
    }
  }

  for (const node of nodes.filter((candidate) => "assertionId" in candidate)) {
    addRelationship("ASSERTS", revision, node, node.source.locator, "graph-lineage", node.temporal);
  }
  addRelationship("USED", ingestion, sourceArtifact, "/", "graph-lineage", { precision: "unknown" });
  addRelationship("GENERATED", ingestion, revision, "/", "graph-lineage", { precision: "unknown" });

  nodes.sort((left, right) => left.semanticId.localeCompare(right.semanticId));
  relationships.sort((left, right) => left.semanticId.localeCompare(right.semanticId));
  const graph: MemberContextGraphSnapshot = { memberId, contextRevisionId: revisionId, sourceArtifactDigest: artifactDigest, nodes, relationships };
  const graphValidation = validateMemberContextGraph(graph);
  if (!graphValidation.valid) throw new MemberContextValidationError(graphValidation.errors);
  return deepFreeze(graph);
}
