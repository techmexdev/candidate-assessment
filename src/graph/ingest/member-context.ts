import { createHash } from "node:crypto";
import type {
  JsonValue,
  MemberContextDocumentInput,
  MemberChatMessage,
  MemberContextSnapshot,
  MemberEvidence,
  EvidenceKind,
} from "../../domain/contracts/member-context";

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
