import coachSessionsData from "../../../data/coach-sessions.json";
import type {
  CoachAthleteSummary,
  CoachDashboardMemberViewModel,
  CoachDashboardViewModel,
  CoachDashboardWorkspace,
  CoachSession,
  CoachTodayProjection,
  DashboardWorkoutItem,
} from "./dashboard-contract";

type MemberSeed = {
  id: string;
  name: string;
  initials: string;
  age: number;
  height: number;
  weight: number;
  tier: string;
  workoutTitle: string;
  joint: string;
  region: string;
  adherence: string;
  sleep: string;
  historyTitle: string;
  exerciseName: string;
};

const coach = { name: "Coach Sam" } as const;
const asOfDate = { weekday: "WED", monthDay: "JUL 8" } as const;

function workoutItem(seed: MemberSeed): DashboardWorkoutItem {
  return {
    id: `${seed.id}:main`,
    name: seed.exerciseName,
    catalogName: seed.exerciseName,
    catalogId: `${seed.id}:catalog`,
    dose: "3×8 · CONTROLLED",
    rest: "60 sec rest",
    why: `Controlled strength work selected for ${seed.region.toLowerCase()} constraints and available equipment.`,
    provenance: "SYNTHETIC ROSTER · WORKOUT BASE",
    decisionId: `${seed.id}:selection`,
  };
}

function member(seed: MemberSeed): CoachDashboardMemberViewModel {
  const item = workoutItem(seed);
  return {
    coach,
    asOfDate,
    workoutTitle: seed.workoutTitle,
    member: {
      id: seed.id,
      name: seed.name,
      initials: seed.initials,
      age: seed.age,
      height: seed.height,
      weight: seed.weight,
      tier: seed.tier,
      memberSince: "2025-01-15",
      trainingDaysPerWeek: 3,
    },
    metrics: { adherence: seed.adherence, sleep: seed.sleep, restingHeartRate: "61" },
    profile: {
      injury: {
        id: `${seed.id}:injury`,
        region: seed.region,
        joint: seed.joint,
        status: "recovering",
        severity: "mild",
        since: "2026-05-01",
        notes: `Keep ${seed.joint.toLowerCase()} loading controlled and pain-free.`,
        snomedct_hint: "synthetic-demo",
        displayName: `${seed.joint} irritation`,
        sinceLabel: "May 1",
        sourceLabel: "SYNTHETIC ATHLETE PROFILE",
      },
      goals: [{ id: `${seed.id}:goal`, text: "Build consistent strength", priority: 1, target_date: null }],
      preferences: {
        preferred_session_minutes: 45,
        training_days_per_week: 3,
        preferred_days: ["Mon", "Wed", "Sat"],
        dislikes: ["burpees"],
        notes: "Prefers concise coaching cues.",
      },
      equipment: ["dumbbells", "bench", "cable machine"],
    },
    workoutSections: [
      { title: "WARM-UP", items: [{ ...item, id: `${seed.id}:warmup`, name: "Mobility flow", catalogName: "Mobility flow", dose: "2 MIN · FLOW" }] },
      { title: "MAIN", items: [item] },
      { title: "COOL-DOWN", items: [{ ...item, id: `${seed.id}:cooldown`, name: "Breathing reset", catalogName: "Breathing reset", dose: "2 MIN" }] },
    ],
    exclusions: [{
      ...item,
      id: `${seed.id}:excluded`,
      name: `${seed.joint} high-impact loading`,
      catalogName: `${seed.joint} high-impact loading`,
      decisionId: `${seed.id}:excluded`,
      reason: `High-impact ${seed.joint.toLowerCase()} loading is excluded during recovery.`,
      overridable: true,
    }],
    decisionPaths: {
      [`${seed.id}:selection`]: {
        kind: "SELECTION",
        lanes: [
          { name: "ATHLETE", text: `${seed.joint} recovering`, source: "SYNTHETIC ATHLETE PROFILE" },
          { name: "WORKOUT", text: `${seed.exerciseName} selected`, source: "SYNTHETIC WORKOUT BASE" },
        ],
      },
      [`${seed.id}:excluded`]: {
        kind: "SAFETY EXCLUSION",
        lanes: [
          { name: "ATHLETE", text: `${seed.joint} recovering`, source: "SYNTHETIC ATHLETE PROFILE" },
          { name: "RULE", text: "Avoid high-impact loading", source: "SYNTHETIC SAFETY RULE" },
        ],
      },
    },
    history: [{
      date: "2026-07-03",
      title: seed.historyTitle,
      planned: true,
      completed: true,
      duration_min: 45,
      rpe: 6,
      exercises: [seed.exerciseName],
    }],
  };
}

const members = [
  member({ id: "mbr_01HX9JORDAN", name: "Jordan Rivera", initials: "JR", age: 34, height: 178, weight: 82, tier: "Premium", workoutTitle: "knee-safe strength", joint: "Knee", region: "Lower body", adherence: "50%", sleep: "6.3h", historyTitle: "Lower-body strength", exerciseName: "Box Squat" }),
  member({ id: "mbr_02HX9AVERY", name: "Avery Chen", initials: "AC", age: 31, height: 178, weight: 68, tier: "Plus", workoutTitle: "shoulder-safe strength", joint: "Shoulder", region: "Upper body", adherence: "75%", sleep: "7.1h", historyTitle: "Upper-body control", exerciseName: "Neutral-Grip Floor Press" }),
  member({ id: "mbr_03HX9MORGAN", name: "Morgan Lee", initials: "ML", age: 38, height: 175, weight: 82, tier: "Standard", workoutTitle: "mobility and strength", joint: "Hip", region: "Lower body", adherence: "80%", sleep: "7.0h", historyTitle: "Full-body strength", exerciseName: "Goblet Squat" }),
];

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function sessionDateKey(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).formatToParts(new Date(value));
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

export function buildTodayProjection(workspace: CoachDashboardWorkspace, selectedDate: string): CoachTodayProjection {
  const sessions = workspace.sessions
    .filter((session) => sessionDateKey(session.startsAt, workspace.timezone) === selectedDate)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const athletesById = new Map(workspace.athletes.map((athlete) => [athlete.id, athlete]));
  const seen = new Set<string>();
  const scheduledAthletes: CoachTodayProjection["scheduledAthletes"] = [];
  for (const session of sessions) {
    if (seen.has(session.athleteId)) continue;
    const athlete = athletesById.get(session.athleteId);
    if (!athlete) continue;
    seen.add(session.athleteId);
    scheduledAthletes.push({ athlete, firstSession: session });
  }
  return { sessions, scheduledAthletes };
}

export function buildCoachWorkspace(memberViewsInput: CoachDashboardMemberViewModel[], sessionsInput: CoachSession[]): CoachDashboardWorkspace {
  const sessions = [...sessionsInput].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const memberViews = Object.fromEntries(memberViewsInput.map((item) => [item.member.id, item]));
  const missing = sessions.find((session) => !memberViews[session.athleteId]);
  if (missing) throw new Error(`Session ${missing.id} references unknown athlete ${missing.athleteId}.`);
  const timezone = "America/Chicago";
  const coachDayDate = sessions[0] ? sessionDateKey(sessions[0].startsAt, timezone) : "2026-07-08";
  const athletes: CoachAthleteSummary[] = memberViewsInput.map((item) => {
    const next = sessions.find((session) => session.athleteId === item.member.id) ?? null;
    const history = item.history[0];
    return {
      id: item.member.id,
      name: item.member.name,
      initials: item.member.initials,
      tier: item.member.tier,
      adherence: item.metrics.adherence,
      suggestedWorkoutTitle: item.workoutTitle,
      lastSessionLabel: `${shortDate(history.date)} · ${history.title}`,
      nextSessionId: next?.id ?? null,
      nextSessionLabel: next ? `${shortDate(next.startsAt)} · ${next.label}` : null,
      nextSessionAt: next?.startsAt ?? null,
    };
  });
  return { coach, asOfDate, coachDayDate, timezone, athletes, sessions, memberViews };
}

const sessions: CoachSession[] = coachSessionsData.map((item) => ({ ...item, status: "upcoming" }));
const workspace = buildCoachWorkspace(members, sessions);

export const syntheticDashboardBase: CoachDashboardViewModel = Object.freeze({ ...members[0], workspace });
