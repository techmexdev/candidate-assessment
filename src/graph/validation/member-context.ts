import syntheticSources from "../../../data/member-context-synthetic-sources.json";
import type {
  DomainConceptReference,
  MemberContextGraphSnapshot,
  MemberContextNodeKind,
  MemberContextRelationshipKind,
} from "../../domain/contracts/member-context";
import {
  MEMBER_CONTEXT_NODE_KINDS,
  MEMBER_CONTEXT_RELATIONSHIP_KINDS,
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
} from "../../domain/contracts/member-context";
import { MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS } from "../schema/member-context-schema";

export type MemberContextValidationResult = { readonly valid: boolean; readonly errors: readonly string[] };

export class MemberContextValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Member context validation failed: ${errors.join("; ")}`);
    this.name = "MemberContextValidationError";
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isTrue(value: unknown): value is true {
  return value === true;
}

function isSourceOrder(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isOffsetTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function hasTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/");
  } catch {
    return false;
  }
}

function keysExactly(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`${path} has unsupported field ${key}`);
  for (const key of allowed) if (!(key in record)) errors.push(`${path} is missing ${key}`);
}

const MOVEMENT_CLINICAL_CONCEPT_PREFIXES = [
  "exercise",
  "muscle",
  "joint",
  "body-region",
  "movement-pattern",
  "movement-demand",
  "equipment",
  "condition",
  "clinical-rule",
  "ontology-concept",
] as const;

export function isMovementClinicalStableConceptId(value: unknown): value is Extract<DomainConceptReference, { state: "reviewed"; graph: "movement-clinical" }>["stableConceptId"] {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator <= 0 || !value.slice(separator + 1).trim()) return false;
  return (MOVEMENT_CLINICAL_CONCEPT_PREFIXES as readonly string[]).includes(value.slice(0, separator));
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function validateMemberContextSource(input: unknown): MemberContextValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["source must be an object"] };

  keysExactly(input, ["_note", "profile", "goals", "preferences", "equipment_available", "injuries", "workout_history", "adherence", "biomarkers", "labs", "chat_history", "coach_brief"], "source", errors);
  const profile = input.profile;
  if (!isRecord(profile)) errors.push("profile must be an object");
  const fixture = isRecord(profile) ? syntheticSources.sources.find((source) => (
    source.member_id === profile.id && source.coach_id === profile.coach_id && source.synthetic_note === input._note
  )) : undefined;
  if (!fixture) errors.push("source cannot prove a checked-in synthetic fixture identity");

  if (isRecord(profile)) {
    keysExactly(profile, ["id", "name", "age", "sex", "height_cm", "weight_kg", "timezone", "member_since", "coach_id", "tier"], "profile", errors);
    for (const key of ["id", "name", "sex", "coach_id", "tier"] as const) if (!isString(profile[key])) errors.push(`profile.${key} must be a non-empty string`);
    for (const key of ["age", "height_cm", "weight_kg"] as const) if (!isNumber(profile[key])) errors.push(`profile.${key} must be a finite number`);
    if (!isDate(profile.member_since)) errors.push("profile.member_since must be a real date");
    if (!hasTimezone(profile.timezone)) errors.push("profile.timezone must be a valid IANA timezone");
  }

  const goals = Array.isArray(input.goals) ? input.goals : [];
  if (!Array.isArray(input.goals)) errors.push("goals must be an array");
  for (const [index, value] of goals.entries()) {
    if (!isRecord(value)) { errors.push(`goals[${index}] must be an object`); continue; }
    keysExactly(value, ["id", "text", "priority", "target_date"], `goals[${index}]`, errors);
    if (!isString(value.id) || !isString(value.text) || !isNumber(value.priority)) errors.push(`goals[${index}] has invalid identity or value`);
    if (value.target_date !== null && !isDate(value.target_date)) errors.push(`goals[${index}].target_date must be null or a real date`);
  }
  if (hasDuplicates(goals.flatMap((goal) => isRecord(goal) && isString(goal.id) ? [goal.id] : []))) errors.push("goals contains duplicate source IDs");

  const preferences = input.preferences;
  if (!isRecord(preferences)) errors.push("preferences must be an object");
  else {
    keysExactly(preferences, ["preferred_session_minutes", "training_days_per_week", "preferred_days", "dislikes", "notes"], "preferences", errors);
    if (!isNumber(preferences.preferred_session_minutes) || !isNumber(preferences.training_days_per_week)) errors.push("preferences numeric fields must be finite numbers");
    if (!Array.isArray(preferences.preferred_days) || !preferences.preferred_days.every(isString)) errors.push("preferences.preferred_days must be strings");
    if (!Array.isArray(preferences.dislikes) || !preferences.dislikes.every(isString)) errors.push("preferences.dislikes must be strings");
    if (typeof preferences.notes !== "string") errors.push("preferences.notes must be a string");
  }

  const equipment = Array.isArray(input.equipment_available) ? input.equipment_available : [];
  if (!Array.isArray(input.equipment_available) || !equipment.every(isString)) errors.push("equipment_available must contain strings");
  if (hasDuplicates(equipment.filter(isString).map((value) => value.toLocaleLowerCase()))) errors.push("equipment_available contains duplicate semantic identities");

  const injuries = Array.isArray(input.injuries) ? input.injuries : [];
  if (!Array.isArray(input.injuries)) errors.push("injuries must be an array");
  for (const [index, value] of injuries.entries()) {
    if (!isRecord(value)) { errors.push(`injuries[${index}] must be an object`); continue; }
    keysExactly(value, ["id", "region", "joint", "status", "severity", "since", "notes", "snomedct_hint"], `injuries[${index}]`, errors);
    for (const key of ["id", "region", "joint", "status", "severity", "notes", "snomedct_hint"] as const) if (!isString(value[key])) errors.push(`injuries[${index}].${key} must be a non-empty string`);
    if (!isDate(value.since)) errors.push(`injuries[${index}].since must be a real date`);
  }
  if (hasDuplicates(injuries.flatMap((injury) => isRecord(injury) && isString(injury.id) ? [injury.id] : []))) errors.push("injuries contains duplicate source IDs");

  const workouts = Array.isArray(input.workout_history) ? input.workout_history : [];
  if (!Array.isArray(input.workout_history)) errors.push("workout_history must be an array");
  const workoutIds: string[] = [];
  for (const [index, value] of workouts.entries()) {
    if (!isRecord(value)) { errors.push(`workout_history[${index}] must be an object`); continue; }
    keysExactly(value, ["date", "title", "planned", "completed", "duration_min", "rpe", "exercises"], `workout_history[${index}]`, errors);
    if (!isDate(value.date) || !isString(value.title)) errors.push(`workout_history[${index}] has invalid date or title`);
    if (typeof value.planned !== "boolean" || typeof value.completed !== "boolean" || !isNumber(value.duration_min)) errors.push(`workout_history[${index}] has invalid status or duration`);
    if (value.rpe !== null && !isNumber(value.rpe)) errors.push(`workout_history[${index}].rpe must be null or numeric`);
    if (!Array.isArray(value.exercises) || !value.exercises.every(isString)) errors.push(`workout_history[${index}].exercises must contain strings`);
    if (isString(value.date) && isString(value.title)) workoutIds.push(`${value.date}|${value.title.toLocaleLowerCase()}`);
    if (Array.isArray(value.exercises) && hasDuplicates(value.exercises.filter(isString).map((item) => item.toLocaleLowerCase()))) errors.push(`workout_history[${index}].exercises contains duplicate semantic identities`);
  }
  if (hasDuplicates(workoutIds)) errors.push("workout_history contains duplicate semantic identities");

  const adherence = input.adherence;
  if (!isRecord(adherence) || !Array.isArray(adherence.weekly_completion_pct) || !isString(adherence.trend)) errors.push("adherence must contain weekly_completion_pct and trend");
  else {
    const weeks: string[] = [];
    for (const [index, value] of adherence.weekly_completion_pct.entries()) {
      if (!isRecord(value) || !isDate(value.week_of) || !isNumber(value.pct)) errors.push(`adherence.weekly_completion_pct[${index}] is invalid`);
      else weeks.push(value.week_of);
    }
    if (hasDuplicates(weeks)) errors.push("adherence.weekly_completion_pct contains duplicate weeks");
  }

  const biomarkers = input.biomarkers;
  if (!isRecord(biomarkers)) errors.push("biomarkers must be an object");
  else {
    keysExactly(biomarkers, ["resting_hr_bpm", "hrv_ms", "sleep_hours_last_7_days", "weight_trend_kg"], "biomarkers", errors);
    if (!isNumber(biomarkers.resting_hr_bpm) || !isNumber(biomarkers.hrv_ms)) errors.push("biomarker HR/HRV values must be finite numbers");
    if (!Array.isArray(biomarkers.sleep_hours_last_7_days) || biomarkers.sleep_hours_last_7_days.length !== 7 || !biomarkers.sleep_hours_last_7_days.every(isNumber)) errors.push("sleep_hours_last_7_days must contain exactly seven numbers");
    if (!Array.isArray(biomarkers.weight_trend_kg)) errors.push("weight_trend_kg must be an array");
    else {
      const dates: string[] = [];
      for (const [index, value] of biomarkers.weight_trend_kg.entries()) {
        if (!isRecord(value) || !isDate(value.date) || !isNumber(value.kg)) errors.push(`weight_trend_kg[${index}] is invalid`);
        else dates.push(value.date);
      }
      if (hasDuplicates(dates)) errors.push("biomarkers.weight_trend_kg contains duplicate dates");
    }
  }

  const labFields = {
    blood_panel: ["date", "ldl_mg_dl", "hdl_mg_dl", "triglycerides_mg_dl", "hba1c_pct", "vitamin_d_ng_ml", "ferritin_ng_ml", "crp_mg_l"],
    dexa_scan: ["date", "body_fat_pct", "lean_mass_kg", "fat_mass_kg", "bone_density_z_score", "visceral_fat_cm2"],
  } as const;
  if (!isRecord(input.labs)) errors.push("labs must be an object");
  else {
    keysExactly(input.labs, Object.keys(labFields), "labs", errors);
    for (const [panel, allowed] of Object.entries(labFields)) {
      const value = input.labs[panel];
      if (!isRecord(value)) { errors.push(`labs.${panel} must be an object`); continue; }
      keysExactly(value, allowed, `labs.${panel}`, errors);
      if (!isDate(value.date)) errors.push(`labs.${panel}.date must be a real date`);
      for (const key of allowed.filter((field) => field !== "date")) if (!isNumber(value[key])) errors.push(`labs.${panel}.${key} must be numeric`);
    }
  }

  const messages = Array.isArray(input.chat_history) ? input.chat_history : [];
  if (!Array.isArray(input.chat_history)) errors.push("chat_history must be an array");
  const messageIds: string[] = [];
  for (const [index, value] of messages.entries()) {
    if (!isRecord(value)) { errors.push(`chat_history[${index}] must be an object`); continue; }
    for (const key of Object.keys(value)) if (!["ts", "from", "text", "attachments"].includes(key)) errors.push(`chat_history[${index}] has unsupported field ${key}`);
    if (!isOffsetTimestamp(value.ts)) errors.push(`chat_history[${index}].ts must be an exact offset timestamp`);
    if (value.from !== "member" && value.from !== "coach") errors.push(`chat_history[${index}].from is unsupported`);
    if (typeof value.text !== "string") errors.push(`chat_history[${index}].text must be a string`);
    if (isString(value.ts) && isString(value.from) && typeof value.text === "string") messageIds.push(`${value.ts}|${value.from}|${value.text}`);
    if (value.attachments !== undefined) {
      if (!Array.isArray(value.attachments)) errors.push(`chat_history[${index}].attachments must be an array`);
      else for (const attachment of value.attachments) {
        if (!isRecord(attachment) || attachment.type !== "image" || typeof attachment.caption !== "string") errors.push(`unsupported chat attachment in message ${index}`);
      }
    }
  }
  if (hasDuplicates(messageIds)) errors.push("chat_history contains duplicate semantic identities");

  const brief = input.coach_brief;
  if (!isRecord(brief) || !isDate(brief.generated_for) || !Array.isArray(brief.morning_tasks) || !isRecord(brief.churn_risk)) errors.push("coach_brief is invalid");
  else {
    const tasks: string[] = [];
    for (const [index, task] of brief.morning_tasks.entries()) {
      if (!isRecord(task) || !isString(task.type) || !isString(task.text)) errors.push(`coach_brief.morning_tasks[${index}] is invalid`);
      else tasks.push(`${task.type}|${task.text}`);
    }
    if (hasDuplicates(tasks)) errors.push("coach_brief.morning_tasks contains duplicate semantic identities");
    if (!isString(brief.churn_risk.level) || !Array.isArray(brief.churn_risk.reasons) || !brief.churn_risk.reasons.every(isString)) errors.push("coach_brief.churn_risk is invalid");
    else if (hasDuplicates(brief.churn_risk.reasons.map((value) => value.toLocaleLowerCase()))) errors.push("coach_brief.churn_risk.reasons contains duplicate semantic identities");
  }

  return { valid: errors.length === 0, errors };
}

const ASSERTION_CLASSIFICATIONS = new Set([
  "identity",
  "source-statement",
  "observation",
  "source-provided-assessment",
  "system-derived-assessment",
  "graph-lineage",
  "publication-state",
]);
const REVISION_SCOPED_KINDS = new Set<string>(MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS);
const NODE_KINDS = new Set<string>(MEMBER_CONTEXT_NODE_KINDS);
const RELATIONSHIP_KINDS = new Set<string>(MEMBER_CONTEXT_RELATIONSHIP_KINDS);

function isNodeKind(value: unknown): value is MemberContextNodeKind {
  return typeof value === "string" && NODE_KINDS.has(value);
}

function isRelationshipKind(value: unknown): value is MemberContextRelationshipKind {
  return typeof value === "string" && RELATIONSHIP_KINDS.has(value);
}

function shape(
  value: Record<string, unknown>,
  path: string,
  checks: Readonly<Record<string, (candidate: unknown) => boolean>>,
  errors: string[],
): void {
  for (const [field, check] of Object.entries(checks)) {
    if (!check(value[field])) errors.push(`${path}.${field} is invalid`);
  }
}

function isTemporal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.precision) {
    case "exact-timestamp":
      return Object.keys(value).length === 2 && isOffsetTimestamp(value.effectiveAt);
    case "date":
      return Object.keys(value).length === 2 && isDate(value.effectiveOn);
    case "relative-order":
      return Object.keys(value).length === 2 && isSourceOrder(value.sourceOrder);
    case "unknown":
      return Object.keys(value).length === 1;
    default:
      return false;
  }
}

function isDomainReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.state === "unresolved") {
    return typeof value.originalText === "string"
      && ["no-deterministic-match", "not-reviewed", "not-applicable"].includes(String(value.reason));
  }
  if (value.state !== "reviewed" || !isString(value.reviewedBy) || !isDate(value.reviewedAt) || !isString(value.sourceArtifactDigest)) return false;
  if (value.graph === "movement-clinical") return isMovementClinicalStableConceptId(value.stableConceptId);
  return value.graph === "copper" && typeof value.stableConceptId === "string" && /^copper:.+/.test(value.stableConceptId);
}

function validateAssertionBase(
  value: Record<string, unknown>,
  path: string,
  memberId: string,
  contextRevisionId: string,
  sourceArtifactDigest: string,
  assertions: Set<string>,
  errors: string[],
): void {
  shape(value, path, {
    memberId: isString,
    contextRevisionId: isString,
    source: isRecord,
    classification: (candidate) => typeof candidate === "string" && ASSERTION_CLASSIFICATIONS.has(candidate),
    temporal: isTemporal,
    synthetic: isBoolean,
  }, errors);
  if (!isString(value.assertionId)) errors.push(`${path} is missing assertion identity`);
  else {
    if (assertions.has(value.assertionId)) errors.push(`${path}.assertionId duplicates another assertion identity`);
    assertions.add(value.assertionId);
  }
  if (value.memberId !== memberId || value.contextRevisionId !== contextRevisionId) errors.push(`${path} has inconsistent revision membership`);
  if (isRecord(value.source)) {
    shape(value.source, `${path}.source`, {
      locator: (candidate) => typeof candidate === "string" && candidate.startsWith("/"),
      artifactDigest: isString,
    }, errors);
    if (value.source.artifactDigest !== sourceArtifactDigest) errors.push(`${path}.source has an inconsistent artifact digest`);
  }
  if (value.synthetic !== true) errors.push(`${path}.synthetic must be true`);
}

function validateNodeShape(node: Record<string, unknown>, path: string, errors: string[]): void {
  switch (node.kind) {
    case "member":
    case "coach":
      shape(node, path, { sourceId: isString, synthetic: isTrue }, errors);
      return;
    case "member-profile":
      shape(node, path, { name: isString, age: isNumber, sex: isString, heightCm: isNumber, weightKg: isNumber, timezone: hasTimezone, memberSince: isDate, tier: isString }, errors);
      return;
    case "goal":
      shape(node, path, { text: isString, priority: isNumber, targetDate: isNullableString, domainReference: isDomainReference }, errors);
      if (node.targetDate !== null && !isDate(node.targetDate)) errors.push(`${path}.targetDate is invalid`);
      return;
    case "preference":
      shape(node, path, {
        preferredSessionMinutes: isNumber,
        trainingDaysPerWeek: isNumber,
        preferredDays: isStringArray,
        dislikes: isStringArray,
        notes: (candidate) => typeof candidate === "string",
        domainReferences: (candidate) => Array.isArray(candidate) && candidate.every(isDomainReference),
      }, errors);
      return;
    case "equipment-availability":
      shape(node, path, { originalLabel: isString, available: isBoolean, domainReference: isDomainReference }, errors);
      return;
    case "injury-episode":
      shape(node, path, { region: isString, joint: isString, status: isString, severity: isString, since: isDate, notes: isString, domainReferences: (candidate) => Array.isArray(candidate) && candidate.every(isDomainReference) }, errors);
      return;
    case "workout-session":
      shape(node, path, { title: isString, planned: isBoolean, completed: isBoolean, durationMinutes: isNumber, rpe: isNullableNumber }, errors);
      return;
    case "exercise-mention":
      shape(node, path, { originalText: isString, sourceOrder: isSourceOrder, domainReference: isDomainReference }, errors);
      return;
    case "observation":
      shape(node, path, {
        metric: isString,
        value: (candidate) => candidate === null || ["string", "number", "boolean"].includes(typeof candidate) && (typeof candidate !== "number" || Number.isFinite(candidate)),
        unit: isString,
        sourceOrder: isSourceOrder,
      }, errors);
      return;
    case "lab-panel":
      shape(node, path, { panelType: (candidate) => ["blood", "dexa", "other"].includes(String(candidate)), label: isString, sourceOrder: isSourceOrder }, errors);
      return;
    case "conversation":
      shape(node, path, { participantSemanticIds: isStringArray }, errors);
      return;
    case "message":
      shape(node, path, { senderRole: (candidate) => candidate === "member" || candidate === "coach", text: (candidate) => typeof candidate === "string", sourceOrder: isSourceOrder }, errors);
      return;
    case "media-attachment":
      shape(node, path, { mediaType: isString, caption: (candidate) => typeof candidate === "string", sourceOrder: isSourceOrder, assetStatus: (candidate) => candidate === "metadata-only", analysisStatus: (candidate) => candidate === "not-analyzed" }, errors);
      return;
    case "coach-brief":
      shape(node, path, { generatedFor: isDate }, errors);
      return;
    case "coach-task":
      shape(node, path, { taskType: isString, text: isString, sourceOrder: isSourceOrder }, errors);
      return;
    case "churn-assessment":
      shape(node, path, { level: isString }, errors);
      if (node.methodRevision !== undefined && !isString(node.methodRevision)) errors.push(`${path}.methodRevision is invalid`);
      return;
    case "churn-reason":
      shape(node, path, { text: isString, sourceOrder: isSourceOrder, basisStatus: (candidate) => candidate === "supported" || candidate === "unsupported-source" }, errors);
      return;
    case "source-artifact":
      shape(node, path, { artifactDigest: isString, sourceLocator: isString, mediaType: isString, synthetic: isTrue }, errors);
      return;
    case "member-context-revision":
      shape(node, path, { memberId: isString, sourceArtifactDigest: isString, schemaVersion: isString, compilerVersion: isString, validationResult: (candidate) => candidate === "valid" || candidate === "invalid", synthetic: isTrue }, errors);
      if (node.wasRevisionOf !== undefined && !isString(node.wasRevisionOf)) errors.push(`${path}.wasRevisionOf is invalid`);
      return;
    case "ingestion-activity":
      shape(node, path, { softwareVersion: isString, startedAt: isString, endedAt: isString, outcome: (candidate) => candidate === "succeeded" || candidate === "failed", synthetic: isTrue }, errors);
      return;
    case "publication-attempt":
      shape(node, path, { memberId: isString, contextRevisionId: isString, state: (candidate) => ["staged", "validated", "rejected", "abandoned"].includes(String(candidate)), attemptedAt: isString }, errors);
      return;
    case "revision-seal":
      shape(node, path, { memberId: isString, contextRevisionId: isString, canonicalDigest: isString, sealedAt: isString }, errors);
      return;
    case "member-context-catalog":
      shape(node, path, { memberId: isString, activeRevisionId: isNullableString }, errors);
      return;
    case "activation-event":
      shape(node, path, { memberId: isString, contextRevisionId: isString, priorRevisionId: isNullableString, actorId: isString, activatedAt: isString }, errors);
      return;
  }
}

const PRIMARY_INCOMING_RELATIONSHIP: Partial<Record<MemberContextNodeKind, readonly MemberContextRelationshipKind[]>> = {
  "member-profile": ["HAS_PROFILE"],
  goal: ["PURSUES"],
  preference: ["HAS_PREFERENCE"],
  "equipment-availability": ["HAS_EQUIPMENT"],
  "injury-episode": ["HAS_INJURY"],
  "workout-session": ["HAS_WORKOUT"],
  "exercise-mention": ["MENTIONS_EXERCISE"],
  observation: ["HAS_OBSERVATION", "CONTAINS_MEASUREMENT"],
  "lab-panel": ["HAS_PANEL"],
  conversation: ["HAS_CONVERSATION"],
  message: ["CONTAINS_MESSAGE"],
  "media-attachment": ["HAS_ATTACHMENT"],
  "coach-brief": ["HAS_BRIEF"],
  "coach-task": ["HAS_TASK"],
  "churn-assessment": ["HAS_ASSESSMENT"],
  "churn-reason": ["HAS_REASON"],
};

function requireCardinality(records: readonly Record<string, unknown>[], kind: string, expected: number, path: string, errors: string[]): void {
  if (records.filter((record) => record.kind === kind).length !== expected) errors.push(`${path} cardinality must be ${expected}`);
}

export function validateMemberContextGraph(snapshot: MemberContextGraphSnapshot | unknown): MemberContextValidationResult {
  const errors: string[] = [];
  if (!isRecord(snapshot)) return { valid: false, errors: ["graph snapshot must be an object"] };
  const memberId = isString(snapshot.memberId) ? snapshot.memberId : "";
  const contextRevisionId = isString(snapshot.contextRevisionId) ? snapshot.contextRevisionId : "";
  const sourceArtifactDigest = isString(snapshot.sourceArtifactDigest) ? snapshot.sourceArtifactDigest : "";
  if (!memberId) errors.push("graph.memberId is invalid");
  if (!contextRevisionId) errors.push("graph.contextRevisionId is invalid");
  if (!sourceArtifactDigest) errors.push("graph.sourceArtifactDigest is invalid");
  const nodeValues = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const relationshipValues = Array.isArray(snapshot.relationships) ? snapshot.relationships : [];
  if (!Array.isArray(snapshot.nodes)) errors.push("graph.nodes must be an array");
  if (!Array.isArray(snapshot.relationships)) errors.push("graph.relationships must be an array");

  const assertions = new Set<string>();
  const nodesBySemanticId = new Map<string, Record<string, unknown>>();
  const nodes: Record<string, unknown>[] = [];
  for (const [index, value] of nodeValues.entries()) {
    const basePath = `graph.nodes[${index}]`;
    if (!isRecord(value)) { errors.push(`${basePath} must be an object`); continue; }
    const path = isString(value.semanticId) ? `${basePath} (${value.semanticId})` : basePath;
    if (!isString(value.semanticId)) errors.push(`${basePath}.semanticId is invalid`);
    if (!isNodeKind(value.kind)) { errors.push(`${path}.kind is unsupported`); continue; }
    nodes.push(value);
    if (isString(value.semanticId)) {
      if (nodesBySemanticId.has(value.semanticId)) errors.push(`${path}.semanticId duplicates another node`);
      nodesBySemanticId.set(value.semanticId, value);
    }
    validateNodeShape(value, path, errors);
    if (value.sourceOrder !== undefined && !isSourceOrder(value.sourceOrder)) errors.push(`${path}.sourceOrder is invalid`);
    if (REVISION_SCOPED_KINDS.has(value.kind)) validateAssertionBase(value, path, memberId, contextRevisionId, sourceArtifactDigest, assertions, errors);
  }

  const relationshipSemanticIds = new Set<string>();
  const relationships: Record<string, unknown>[] = [];
  for (const [index, value] of relationshipValues.entries()) {
    const basePath = `graph.relationships[${index}]`;
    if (!isRecord(value)) { errors.push(`${basePath} must be an object`); continue; }
    const path = isString(value.semanticId) ? `${basePath} (${value.semanticId})` : basePath;
    if (!isString(value.semanticId)) errors.push(`${basePath}.semanticId is invalid`);
    else {
      if (relationshipSemanticIds.has(value.semanticId)) errors.push(`${path}.semanticId duplicates another relationship`);
      relationshipSemanticIds.add(value.semanticId);
    }
    if (!isRelationshipKind(value.kind)) { errors.push(`${path}.kind is unsupported`); continue; }
    relationships.push(value);
    validateAssertionBase(value, path, memberId, contextRevisionId, sourceArtifactDigest, assertions, errors);
    shape(value, path, { fromSemanticId: isString, fromKind: isNodeKind, toSemanticId: isString, toKind: isNodeKind }, errors);
    if (value.sourceOrder !== undefined && !isSourceOrder(value.sourceOrder)) errors.push(`${path}.sourceOrder is invalid`);
    const from = isString(value.fromSemanticId) ? nodesBySemanticId.get(value.fromSemanticId) : undefined;
    const to = isString(value.toSemanticId) ? nodesBySemanticId.get(value.toSemanticId) : undefined;
    if (!from || !to) { errors.push(`${path} has a dangling endpoint`); continue; }
    const endpoint = MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS[value.kind];
    if (!(endpoint.from as readonly MemberContextNodeKind[]).includes(from.kind as MemberContextNodeKind)
      || !(endpoint.to as readonly MemberContextNodeKind[]).includes(to.kind as MemberContextNodeKind)) errors.push(`${path} has invalid endpoint kinds`);
    if (from.kind !== value.fromKind || to.kind !== value.toKind) errors.push(`${path} has inconsistent declared endpoint kinds`);
  }

  requireCardinality(nodes, "member-context-revision", 1, "graph.nodes member-context-revision", errors);
  requireCardinality(nodes, "source-artifact", 1, "graph.nodes source-artifact", errors);
  requireCardinality(nodes, "member", 1, "graph.nodes member", errors);
  requireCardinality(nodes, "coach", 1, "graph.nodes coach", errors);
  requireCardinality(nodes, "ingestion-activity", 1, "graph.nodes ingestion-activity", errors);
  requireCardinality(nodes, "member-profile", 1, "graph.nodes member-profile", errors);
  requireCardinality(nodes, "preference", 1, "graph.nodes preference", errors);
  requireCardinality(nodes, "conversation", 1, "graph.nodes conversation", errors);
  requireCardinality(nodes, "coach-brief", 1, "graph.nodes coach-brief", errors);
  requireCardinality(nodes, "churn-assessment", 1, "graph.nodes churn-assessment", errors);

  const revision = nodes.find((node) => node.kind === "member-context-revision");
  if (!revision || revision.semanticId !== contextRevisionId || revision.sourceArtifactDigest !== sourceArtifactDigest || revision.memberId !== memberId) errors.push("graph revision root is inconsistent");
  const artifact = nodes.find((node) => node.kind === "source-artifact");
  if (!artifact || artifact.artifactDigest !== sourceArtifactDigest) errors.push("graph source artifact root is inconsistent");
  const member = nodes.find((node) => node.kind === "member");
  if (!member || member.sourceId !== memberId) errors.push("graph member root is inconsistent");

  for (const kind of ["COACHES", "HAS_PROFILE", "HAS_PREFERENCE", "HAS_CONVERSATION", "HAS_BRIEF", "HAS_ASSESSMENT", "USED", "GENERATED"] as const) {
    requireCardinality(relationships, kind, 1, `graph.relationships ${kind}`, errors);
  }
  for (const node of nodes.filter((candidate) => isNodeKind(candidate.kind) && REVISION_SCOPED_KINDS.has(candidate.kind))) {
    if (!isString(node.semanticId)) continue;
    const asserts = relationships.filter((edge) => edge.kind === "ASSERTS" && edge.toSemanticId === node.semanticId && edge.fromSemanticId === contextRevisionId);
    if (asserts.length !== 1) errors.push(`graph node ${node.semanticId} must have exactly one ASSERTS relationship from the revision`);
    const primaryKinds = PRIMARY_INCOMING_RELATIONSHIP[node.kind as MemberContextNodeKind] ?? [];
    const primary = relationships.filter((edge) => primaryKinds.includes(edge.kind as MemberContextRelationshipKind) && edge.toSemanticId === node.semanticId);
    if (primary.length !== 1) errors.push(`graph node ${node.semanticId} must have exactly one primary incoming relationship`);
    if (node.kind === "message" && relationships.filter((edge) => edge.kind === "SENT_BY" && edge.fromSemanticId === node.semanticId).length !== 1) errors.push(`graph node ${node.semanticId} must have exactly one SENT_BY relationship`);
  }

  for (const panelType of ["blood", "dexa"] as const) {
    if (nodes.filter((node) => node.kind === "lab-panel" && node.panelType === panelType).length !== 1) errors.push(`graph.nodes lab-panel ${panelType} cardinality must be 1`);
  }
  const requiredObservationMetrics = [
    "resting-heart-rate",
    "heart-rate-variability",
    "adherence-trend",
    "ldl-cholesterol",
    "hdl-cholesterol",
    "triglycerides",
    "hemoglobin-a1c",
    "vitamin-d",
    "ferritin",
    "c-reactive-protein",
    "body-fat",
    "lean-mass",
    "fat-mass",
    "bone-density-z-score",
    "visceral-fat-area",
  ];
  for (const metric of requiredObservationMetrics) {
    if (nodes.filter((node) => node.kind === "observation" && node.metric === metric).length !== 1) errors.push(`graph.nodes observation metric ${metric} cardinality must be 1`);
  }
  if (nodes.filter((node) => node.kind === "observation" && node.metric === "sleep-hours").length !== 7) errors.push("graph.nodes observation metric sleep-hours cardinality must be 7");

  return { valid: errors.length === 0, errors };
}
