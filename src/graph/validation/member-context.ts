import syntheticSources from "../../../data/member-context-synthetic-sources.json";
import type {
  MemberContextGraphSnapshot,
  MemberContextNodeKind,
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

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function keysExactly(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`${path} has unsupported field ${key}`);
  for (const key of allowed) if (!(key in record)) errors.push(`${path} is missing ${key}`);
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
  for (const id of duplicates(goals.flatMap((goal) => isRecord(goal) && isString(goal.id) ? [goal.id] : []))) errors.push(`duplicate goal source ID ${id}`);

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
  for (const label of duplicates(equipment.filter(isString).map((value) => value.toLocaleLowerCase()))) errors.push(`duplicate equipment semantic identity ${label}`);

  const injuries = Array.isArray(input.injuries) ? input.injuries : [];
  if (!Array.isArray(input.injuries)) errors.push("injuries must be an array");
  for (const [index, value] of injuries.entries()) {
    if (!isRecord(value)) { errors.push(`injuries[${index}] must be an object`); continue; }
    keysExactly(value, ["id", "region", "joint", "status", "severity", "since", "notes", "snomedct_hint"], `injuries[${index}]`, errors);
    for (const key of ["id", "region", "joint", "status", "severity", "notes", "snomedct_hint"] as const) if (!isString(value[key])) errors.push(`injuries[${index}].${key} must be a non-empty string`);
    if (!isDate(value.since)) errors.push(`injuries[${index}].since must be a real date`);
  }
  for (const id of duplicates(injuries.flatMap((injury) => isRecord(injury) && isString(injury.id) ? [injury.id] : []))) errors.push(`duplicate injury source ID ${id}`);

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
    if (Array.isArray(value.exercises)) for (const text of duplicates(value.exercises.filter(isString).map((item) => item.toLocaleLowerCase()))) errors.push(`duplicate exercise semantic identity ${text} in workout ${String(value.date)}`);
  }
  for (const id of duplicates(workoutIds)) errors.push(`duplicate workout semantic identity ${id}`);

  const adherence = input.adherence;
  if (!isRecord(adherence) || !Array.isArray(adherence.weekly_completion_pct) || !isString(adherence.trend)) errors.push("adherence must contain weekly_completion_pct and trend");
  else {
    const weeks: string[] = [];
    for (const [index, value] of adherence.weekly_completion_pct.entries()) {
      if (!isRecord(value) || !isDate(value.week_of) || !isNumber(value.pct)) errors.push(`adherence.weekly_completion_pct[${index}] is invalid`);
      else weeks.push(value.week_of);
    }
    for (const week of duplicates(weeks)) errors.push(`duplicate adherence week ${week}`);
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
      for (const date of duplicates(dates)) errors.push(`duplicate weight date ${date}`);
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
    if (value.from !== "member" && value.from !== "coach") errors.push(`unsupported chat author ${String(value.from)}`);
    if (typeof value.text !== "string") errors.push(`chat_history[${index}].text must be a string`);
    if (isString(value.ts) && isString(value.from) && typeof value.text === "string") messageIds.push(`${value.ts}|${value.from}|${value.text}`);
    if (value.attachments !== undefined) {
      if (!Array.isArray(value.attachments)) errors.push(`chat_history[${index}].attachments must be an array`);
      else for (const attachment of value.attachments) {
        if (!isRecord(attachment) || attachment.type !== "image" || typeof attachment.caption !== "string") errors.push(`unsupported chat attachment in message ${index}`);
      }
    }
  }
  for (const id of duplicates(messageIds)) errors.push(`duplicate message semantic identity ${id}`);

  const brief = input.coach_brief;
  if (!isRecord(brief) || !isDate(brief.generated_for) || !Array.isArray(brief.morning_tasks) || !isRecord(brief.churn_risk)) errors.push("coach_brief is invalid");
  else {
    const tasks: string[] = [];
    for (const [index, task] of brief.morning_tasks.entries()) {
      if (!isRecord(task) || !isString(task.type) || !isString(task.text)) errors.push(`coach_brief.morning_tasks[${index}] is invalid`);
      else tasks.push(`${task.type}|${task.text}`);
    }
    for (const id of duplicates(tasks)) errors.push(`duplicate task semantic identity ${id}`);
    if (!isString(brief.churn_risk.level) || !Array.isArray(brief.churn_risk.reasons) || !brief.churn_risk.reasons.every(isString)) errors.push("coach_brief.churn_risk is invalid");
    else for (const reason of duplicates(brief.churn_risk.reasons.map((value) => value.toLocaleLowerCase()))) errors.push(`duplicate churn reason semantic identity ${reason}`);
  }

  return { valid: errors.length === 0, errors };
}

export function validateMemberContextGraph(snapshot: MemberContextGraphSnapshot): MemberContextValidationResult {
  const errors: string[] = [];
  const nodes = new Map<string, (typeof snapshot.nodes)[number]>();
  const assertions = new Set<string>();
  for (const node of snapshot.nodes) {
    if (nodes.has(node.semanticId)) errors.push(`duplicate semantic identity ${node.semanticId}`);
    nodes.set(node.semanticId, node);
    if ("assertionId" in node) {
      if (assertions.has(node.assertionId)) errors.push(`duplicate assertion identity ${node.assertionId}`);
      assertions.add(node.assertionId);
      if (node.memberId !== snapshot.memberId || node.contextRevisionId !== snapshot.contextRevisionId) errors.push(`revision membership mismatch for ${node.semanticId}`);
      if (node.source.artifactDigest !== snapshot.sourceArtifactDigest) errors.push(`source digest mismatch for ${node.semanticId}`);
      if (!node.source.locator.startsWith("/")) errors.push(`invalid source locator for ${node.semanticId}`);
      if (!node.synthetic) errors.push(`non-synthetic assertion ${node.semanticId}`);
    }
  }
  for (const edge of snapshot.relationships) {
    if (assertions.has(edge.assertionId)) errors.push(`duplicate assertion identity ${edge.assertionId}`);
    assertions.add(edge.assertionId);
    const from = nodes.get(edge.fromSemanticId);
    const to = nodes.get(edge.toSemanticId);
    if (!from || !to) { errors.push(`dangling relationship ${edge.semanticId}`); continue; }
    const endpoint = MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS[edge.kind];
    if (!(endpoint.from as readonly MemberContextNodeKind[]).includes(from.kind) || !(endpoint.to as readonly MemberContextNodeKind[]).includes(to.kind)) errors.push(`invalid endpoints for ${edge.semanticId}`);
    if (from.kind !== edge.fromKind || to.kind !== edge.toKind) errors.push(`declared endpoint kind mismatch for ${edge.semanticId}`);
    if (edge.memberId !== snapshot.memberId || edge.contextRevisionId !== snapshot.contextRevisionId) errors.push(`relationship revision mismatch for ${edge.semanticId}`);
    if (edge.source.artifactDigest !== snapshot.sourceArtifactDigest || !edge.synthetic) errors.push(`relationship provenance mismatch for ${edge.semanticId}`);
  }
  const revision = snapshot.nodes.find((node) => node.kind === "member-context-revision");
  if (!revision || revision.semanticId !== snapshot.contextRevisionId || revision.sourceArtifactDigest !== snapshot.sourceArtifactDigest) errors.push("missing or inconsistent member context revision node");
  if (snapshot.nodes.filter((node) => node.kind === "source-artifact" && node.artifactDigest === snapshot.sourceArtifactDigest).length !== 1) errors.push("source artifact cardinality must be one");
  if (snapshot.nodes.filter((node) => node.kind === "member" && node.sourceId === snapshot.memberId).length !== 1) errors.push("member identity cardinality must be one");
  return { valid: errors.length === 0, errors };
}
