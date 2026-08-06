export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type MemberProfile = {
  id: string;
  name: string;
  age: number;
  sex: string;
  height_cm: number;
  weight_kg: number;
  timezone: string;
  member_since: string;
  coach_id: string;
  tier: string;
};

export type MemberGoal = { id: string; text: string; priority: number; target_date: string | null };
export type MemberPreference = {
  preferred_session_minutes: number;
  training_days_per_week: number;
  preferred_days: string[];
  dislikes: string[];
  notes: string;
};
export type MemberInjury = {
  id: string;
  region: string;
  joint: string;
  status: string;
  severity: string;
  since: string;
  notes: string;
  snomedct_hint: string;
};
export type MemberWorkout = {
  date: string;
  title: string;
  planned: boolean;
  completed: boolean;
  duration_min: number;
  rpe: number | null;
  exercises: string[];
};
export type MemberChatAttachment = { type: "image"; caption: string };
export type MemberChatMessage = {
  ts: string;
  from: "member" | "coach";
  text: string;
  attachments?: MemberChatAttachment[];
};
export type MemberContextDocument = {
  _note: string;
  profile: MemberProfile;
  goals: MemberGoal[];
  preferences: MemberPreference;
  equipment_available: string[];
  injuries: MemberInjury[];
  workout_history: MemberWorkout[];
  adherence: { weekly_completion_pct: { week_of: string; pct: number }[]; trend: string };
  biomarkers: {
    resting_hr_bpm: number;
    hrv_ms: number;
    sleep_hours_last_7_days: number[];
    weight_trend_kg: { date: string; kg: number }[];
  };
  labs: Record<string, Record<string, string | number>>;
  chat_history: MemberChatMessage[];
  coach_brief: {
    generated_for: string;
    morning_tasks: { type: string; text: string }[];
    churn_risk: { level: string; reasons: string[] };
  };
};

export type MemberContextDocumentInput = Omit<MemberContextDocument, "chat_history"> & {
  chat_history: {
    ts: string;
    from: string;
    text: string;
    attachments?: { type: string; caption: string }[];
  }[];
};

export type EvidenceKind =
  | "profile"
  | "goal"
  | "preference"
  | "equipment"
  | "injury"
  | "workout"
  | "adherence"
  | "biomarker"
  | "lab"
  | "message"
  | "image"
  | "coach-task"
  | "churn-signal";

export type MemberEvidence = {
  evidenceId: string;
  memberId: string;
  kind: EvidenceKind;
  occurredAt: string;
  recordedAt: string;
  sourcePath: string;
  sourceRevision: string;
  synthetic: true;
  value: JsonValue;
};

export type MemberContextSnapshot = {
  memberId: string;
  coachId: string;
  datasetRevision: string;
  contextRevision: string;
  asOf: string;
  timezone: string;
  synthetic: true;
  profile: MemberProfile;
  goals: MemberGoal[];
  preferences: MemberPreference;
  equipmentAvailable: string[];
  injuries: MemberInjury[];
  workoutHistory: MemberWorkout[];
  adherence: MemberContextDocument["adherence"];
  biomarkers: MemberContextDocument["biomarkers"];
  labs: MemberContextDocument["labs"];
  chatHistory: MemberChatMessage[];
  coachBrief: MemberContextDocument["coach_brief"];
  evidence: MemberEvidence[];
};

export type MemberScope = { coachId: string; memberId: string };
export type MemberContextResult =
  | { status: "ready"; data: MemberContextSnapshot }
  | { status: "empty"; message: string }
  | { status: "denied"; message: string }
  | { status: "unavailable"; message: string };
