import exercisesData from "../../../data/exercises.json";
import averyMemberContextData from "../../../data/member-context-avery.json";
import coachSessionsData from "../../../data/coach-sessions.json";
import memberContextData from "../../../data/member-context.json";
import morganMemberContextData from "../../../data/member-context-morgan.json";
import { compileMemberContextGraph } from "../../graph/ingest/member-context";
import { compileDefaultMovementGraph } from "../../graph/ingest/movement-clinical";
import { projectMemberContextGraphSnapshot, projectMovementGraphSnapshot, type FullGraphReadResult } from "../../domain/contracts/full-graph-view";
import type {
  CoachAthleteSummary,
  CoachDashboardMemberViewModel,
  CoachDashboardFixtureMemberViewModel,
  CoachDashboardWorkspace,
  CoachDashboardViewModel,
  CoachTodayProjection,
  DashboardAdapter,
  DashboardCopilotCard,
  DashboardFullGraphClient,
  DashboardFullGraphRequest,
  CoachSession,
  DashboardInsightId,
  DashboardWorkoutItem,
} from "./dashboard-contract";

type CatalogExercise = (typeof exercisesData)[number];
export type MemberContext = typeof memberContextData;

type WorkoutItem = DashboardWorkoutItem;

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function roundedAverage(values: number[]) {
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function buildDashboardFixture(
  memberContext: MemberContext,
  exercises: CatalogExercise[],
): CoachDashboardFixtureMemberViewModel {
  const profile = memberContext.profile;
  const latestAdherence = memberContext.adherence.weekly_completion_pct.at(-1)!;
  const latestWorkout = memberContext.workout_history[0];
  const injury = memberContext.injuries[0];
  const exerciseByName = new Map(exercises.map((exercise) => [exercise.name, exercise]));
  const catalogItem = (
    id: string,
    catalogName: string,
    dose: string,
    why: string,
    provenance: string,
    decisionId?: string,
  ): WorkoutItem => {
    const exercise = exerciseByName.get(catalogName);
    if (!exercise) throw new Error(`Dashboard fixture references missing catalog exercise: ${catalogName}`);
    return { id, name: catalogName, dose, why, provenance, decisionId, catalogId: exercise.id, catalogName };
  };
  const contextualItem = (
    id: string,
    name: string,
    dose: string,
    why: string,
    provenance: string,
    decisionId?: string,
  ): WorkoutItem => ({ id, name, dose, why, provenance, decisionId, catalogId: null, catalogName: name });

  const adherenceBars = memberContext.adherence.weekly_completion_pct.map(({ week_of, pct }) => ({
    label: `${Number(week_of.slice(5, 7))}/${Number(week_of.slice(8, 10))}`,
    value: pct,
    displayValue: `${pct}%`,
  }));
  const sleepAverage = roundedAverage(memberContext.biomarkers.sleep_hours_last_7_days);
  const skippedWorkout = memberContext.workout_history.find((workout) => !workout.completed)!;
  const isShoulderPlan = injury.joint.toLowerCase().includes("shoulder");
  const injuryLabel = injury.joint.toLowerCase();

  const copilotCards: Record<DashboardInsightId, DashboardCopilotCard> = {
    brief: {
      id: "brief",
      kicker: "MORNING BRIEF · THU JUN 4",
      title: `Celebrate ${profile.name}'s recent win, watch churn`,
      rows: [
        { label: "CELEBRATE", value: memberContext.coach_brief.morning_tasks[0].text },
        { label: "RISK", value: `Adherence ${memberContext.adherence.weekly_completion_pct[0].pct}% → ${latestAdherence.pct}% over 2 weeks · churn ${memberContext.coach_brief.churn_risk.level}` },
        { label: "DO NEXT", value: `Reply to ${profile.name}'s check-in · review today's draft` },
      ],
      sources: ["workout 06/03", "adherence log", "chat 06/03"],
    },
    adherence: {
      id: "adherence",
      kicker: "ADHERENCE",
      title: `Declining — ${adherenceBars[0].value}% → ${latestAdherence.pct}%`,
      headline: `Two strong weeks, then a slide. One skipped session (“${memberContext.chat_history.find((message) => message.text.includes("work blew up"))?.text.split(", ")[1]?.replace(" Sorry!", "") ?? "work fatigue"}”).`,
      bars: adherenceBars,
      sources: ["adherence log · 4 wks", "chat 05/30"],
      detail: {
        recent: `${latestAdherence.pct}% last week — ${skippedWorkout.title} was not completed.`,
        trend: `Weekly completion moved from ${adherenceBars[0].value}% to ${latestAdherence.pct}%.`,
        stable: `Preference remains ${memberContext.preferences.training_days_per_week} days/week.`,
        action: `Trim sessions to 35–40 min this week and anchor the check-in on the recent ${injuryLabel} milestone.`,
      },
    },
    sleep: {
      id: "sleep",
      kicker: "SLEEP",
      title: `${sleepAverage}h avg vs 7h goal`,
      headline: "Two nights under 5.5h this week; weekends recover.",
      bars: memberContext.biomarkers.sleep_hours_last_7_days.map((value, index) => ({
        label: ["F", "S", "S", "M", "T", "W", "T"][index],
        value,
        displayValue: `${value} hours`,
      })),
      sources: ["sleep log · 7 days", "goal: 7h weeknights"],
      detail: {
        recent: `${sleepAverage}h average over the last 7 days; ${Math.min(...memberContext.biomarkers.sleep_hours_last_7_days)}h was the low.`,
        trend: "Weeknights remain under the goal while weekends recover.",
        stable: memberContext.goals.find((goal) => goal.id === "goal_sleep")!.text,
        action: "Keep intensity moderate after short-sleep nights; today qualifies.",
      },
    },
    change: {
      id: "change",
      kicker: "WEEK OVER WEEK",
      title: "What changed since last week",
      rows: [
        { label: "ADHERENCE", value: `${adherenceBars.at(-2)!.value}% → ${latestAdherence.pct}% — one planned session missed` },
        { label: "SLEEP", value: `${sleepAverage}h current average — still under goal` },
        { label: injury.joint.toUpperCase(), value: `Recent completed work ✓ (${latestWorkout.exercises[0] ?? latestWorkout.title})` },
      ],
      sources: ["4 workouts", "sleep log", "2 messages"],
    },
    churn: {
      id: "churn",
      kicker: "CHURN RISK",
      title: `${memberContext.coach_brief.churn_risk.level[0].toUpperCase()}${memberContext.coach_brief.churn_risk.level.slice(1)} — act this week`,
      bars: adherenceBars,
      rows: [
        { label: "SIGNALS", value: memberContext.coach_brief.churn_risk.reasons.join(" · ") },
        { label: "COUNTER", value: `${latestWorkout.title} completed + recent member check-in` },
      ],
      sources: ["adherence log", "chat 05/30", "login events"],
      detail: {
        recent: `${skippedWorkout.title} was missed; the latest member check-in is available for follow-up.`,
        trend: "Engagement has slid for 2 weeks across sessions and logins.",
        stable: `${profile.tier} member since ${profile.member_since}.`,
        action: `Send a personal nudge tied to the recent ${injuryLabel} milestone before scheduling this week.`,
      },
    },
  };

  const splitSquat = catalogItem(
    "split-squat",
    "Dumbbell Goblet Split Squat",
    "2×8 · LIGHT",
    `Excluded for ${injury.region} ${injury.status}: avoid deep flexion under load.`,
    "CATALOG · INJURY REPORT 05/10",
    "split-squat",
  );

  return {
    coach: { name: "Coach Sam" },
    asOfDate: {
      weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(memberContext.coach_brief.generated_for)).toUpperCase(),
      monthDay: shortDate(memberContext.coach_brief.generated_for).toUpperCase(),
    },
    workoutTitle: `${injury.joint}-safe strength`,
    member: {
      id: profile.id,
      name: profile.name,
      initials: initials(profile.name),
      age: profile.age,
      height: profile.height_cm,
      weight: profile.weight_kg,
      tier: profile.tier,
      memberSince: profile.member_since,
      trainingDaysPerWeek: memberContext.preferences.training_days_per_week,
    },
    metrics: {
      adherence: `${latestAdherence.pct}%`,
      sleep: `${sleepAverage}h`,
      restingHeartRate: `${memberContext.biomarkers.resting_hr_bpm}`,
    },
    morningBrief: {
      celebrationTitle: `${latestWorkout.title} completed`,
      celebration: memberContext.coach_brief.morning_tasks[0].text,
      celebrationSummary: `${latestWorkout.title} · ${shortDate(latestWorkout.date)} · ${latestWorkout.duration_min} min. Worth celebrating today.`,
      riskTitle: `Churn risk ${memberContext.coach_brief.churn_risk.level}`,
      risk: memberContext.coach_brief.morning_tasks[1].text,
      riskSummary: `Adherence ${memberContext.adherence.weekly_completion_pct[0].pct}% → ${latestAdherence.pct}% in 2 weeks · logins down`,
      memberMessage: memberContext.chat_history[0].text,
      memberMessageDate: shortDate(memberContext.chat_history[0].ts.slice(0, 10)),
    },
    profile: {
      injury: {
        ...injury,
        displayName: injury.notes.split(" after ")[0],
        sinceLabel: shortDate(injury.since),
        sourceLabel: `INJURY REPORT · ${shortDate(injury.since).toUpperCase()} · SNOMED CT SUBSET`,
      },
      goals: memberContext.goals,
      preferences: memberContext.preferences,
      equipment: memberContext.equipment_available,
    },
    workoutSections: isShoulderPlan ? [
      {
        title: "WARM-UP",
        items: [
          catalogItem("worlds-greatest-stretch", "World's Greatest Stretch", "2 MIN · FLOW", "Dynamic mobility before controlled upper-body loading.", "CATALOG · MOBILITY-DYNAMIC"),
          contextualItem("scapular-wall-slide", "Scapular Wall Slide", "2×8 · CONTROLLED", "Shoulder-blade control before pressing; stay in a pain-free range.", `INJURY REPORT · ${shortDate(injury.since).toUpperCase()}`),
        ],
      },
      {
        title: "MAIN",
        items: [
          contextualItem("floor-press", "Dumbbell Neutral-Grip Floor Press", "3×8 · CONTROLLED", "Controlled neutral-grip pressing matches the shoulder clearance and available dumbbells.", "INJURY REPORT · EQUIPMENT", "floor-press"),
          contextualItem("cable-row", "Single-Arm Cable Row", "3×10 / SIDE", "Upper-back strength with a cable machine and no painful overhead position.", "GOALS · EQUIPMENT"),
          catalogItem("split-squat", "Dumbbell Goblet Split Squat", "3×8 / SIDE", "Lower-body strength work that does not load the irritated shoulder overhead.", "CATALOG · GOALS"),
          contextualItem("dead-bug", "Dead Bug", "3×8 / SIDE", "Trunk control with no shoulder loading beyond a comfortable position.", "WORKOUT HISTORY · SAFETY"),
        ],
      },
      {
        title: "COOL-DOWN",
        items: [
          catalogItem("cow-pose", "Cow Pose", "1 MIN · MAT", "Down-regulation and gentle spinal mobility.", "CATALOG · REGEN"),
          catalogItem("upper-trap-stretch", "Ground Upper Trap Stretch", "1 MIN / SIDE", "Gentle neck and trap release without overhead loading.", "CATALOG · MOBILITY-STATIC"),
        ],
      },
    ] : [
      {
        title: "WARM-UP",
        items: [
          catalogItem("worlds-greatest-stretch", "World's Greatest Stretch", "2 MIN · FLOW", "Dynamic full-body mobility with no loaded knee flexion.", "CATALOG · MOBILITY-DYNAMIC"),
          contextualItem("banded-lateral-walk", "Banded Lateral Walk", "2×12 · LOOP BAND", "Knee-stability activation; loop band available at home.", "WORKOUT LOG 06/03 · EQUIPMENT"),
        ],
      },
      {
        title: "MAIN",
        items: [
          contextualItem("box-goblet-squat", "Box Goblet Squat", "3×10 · DUMBBELL", "Strength goal + first pain-free box squats Jun 3.", "GOALS · WORKOUT LOG 06/03", "box-squat"),
          contextualItem("step-up", "Step-Up (low box)", "3×8 / SIDE · DUMBBELL", "Knee-safe lower push selected where jumping was removed.", "WORKOUT LOG 05/27 · SAFETY", "jumps"),
          contextualItem("hip-thrust", "Hip Thrust", "3×12 · BENCH", "Posterior chain with minimal knee flexion; bench available at home.", "WORKOUT LOG 06/03 · EQUIPMENT"),
          catalogItem("bench-press", "Dumbbell Neutral-Grip Bench Press", "3×10 · DB + BENCH", "Upper push; dumbbells and flat bench are available.", "CATALOG · EQUIPMENT"),
        ],
      },
      {
        title: "COOL-DOWN",
        items: [
          catalogItem("cow-pose", "Cow Pose", "1 MIN · MAT", "Down-regulation and gentle lumbar mobility.", "CATALOG · REGEN"),
          catalogItem("upper-trap-stretch", "Ground Upper Trap Stretch", "1 MIN / SIDE", "Neck and trap release to close.", "CATALOG · MOBILITY-STATIC"),
        ],
      },
    ],
    exclusions: isShoulderPlan ? [
      { ...catalogItem("overhead-press", "Alternating Dumbbell Overhead Press", "", "", "CATALOG · INJURY REPORT", "overhead-press"), decisionId: "overhead-press", reason: `Painful overhead volume avoided while ${injury.region} is ${injury.status}`, overridable: true },
      { ...contextualItem("wide-grip-pull-up", "Wide-Grip Pull-Up", "", "", "INJURY REPORT", "wide-grip-pull-up"), decisionId: "wide-grip-pull-up", reason: "Wide overhead position removed during shoulder monitoring", overridable: false },
      { ...contextualItem("burpees", "Burpees", "", "", "MEMBER PREFERENCES", "burpees"), decisionId: "burpees", reason: "Member dislikes burpees — explicit preference exclusion", overridable: false },
    ] : [
      { ...splitSquat, decisionId: "split-squat", reason: "Deep knee flexion under load — patellofemoral pain (recovering)", overridable: true },
      { ...catalogItem("jumps", "Static Jump", "", "", "CATALOG · INJURY REPORT", "jumps"), decisionId: "jumps", reason: "Plyometric loading contraindicated during knee recovery", overridable: false },
      { ...contextualItem("deadlifts", "Deadlift variations", "", "", "MEMBER PREFERENCES", "deadlifts"), decisionId: "deadlifts", reason: "Member dislikes deadlifts — explicit preference exclusion", overridable: false },
    ],
    decisionPaths: isShoulderPlan ? {
      "overhead-press": {
        kind: "SAFETY EXCLUSION",
        lanes: [
          { name: "MEMBER", text: `${injury.region} · ${injury.status}`, source: `INJURY REPORT · ${shortDate(injury.since).toUpperCase()}` },
          { name: "ANATOMY", text: "shoulder joint and overhead loading", source: "SNOMED CT SUBSET" },
          { name: "RULE", text: "Avoid painful overhead volume", source: "GRADED-RETURN RULE" },
          { name: "WORKOUT", text: "Overhead press removed", source: "SAFETY LAYER · DETERMINISTIC" },
        ],
      },
      "wide-grip-pull-up": {
        kind: "SAFETY EXCLUSION",
        lanes: [
          { name: "MEMBER", text: `${injury.region} · ${injury.status}`, source: "INJURY REPORT" },
          { name: "ANATOMY", text: "wide overhead position", source: "MOVEMENT CLASSIFICATION" },
          { name: "RULE", text: "Keep upper-body work in a comfortable range", source: "GRADED-RETURN RULE" },
          { name: "WORKOUT", text: "Wide-grip pull-up hidden", source: "SAFETY FILTER" },
        ],
      },
      burpees: {
        kind: "PREFERENCE",
        lanes: [
          { name: "MEMBER", text: `Dislikes: ${memberContext.preferences.dislikes.join(", ")}`, source: "MEMBER PREFERENCES" },
          { name: "ANATOMY", text: "No anatomy restriction", source: "—" },
          { name: "RULE", text: "Explicit preference exclusion", source: "PREFERENCE FILTER" },
          { name: "WORKOUT", text: "Burpees hidden", source: "PREFERENCE FILTER" },
        ],
      },
      "floor-press": {
        kind: "SELECTION",
        lanes: [
          { name: "MEMBER", text: `${memberContext.goals[0].text}; controlled pressing felt comfortable`, source: "GOALS · MEMBER CHECK-IN" },
          { name: "ANATOMY", text: `${injury.region} monitored`, source: "INJURY REPORT" },
          { name: "RULE", text: "Prefer controlled neutral-grip pressing", source: "GRADED-RETURN RULE" },
          { name: "WORKOUT", text: "Neutral-grip floor press selected", source: "COMPOSER · EQUIPMENT" },
        ],
      },
    } : {
      "split-squat": {
        kind: "SAFETY EXCLUSION",
        lanes: [
          { name: "MEMBER", text: `${injury.region} pain · ${injury.status}`, source: "INJURY REPORT · 05/10" },
          { name: "ANATOMY", text: "patellofemoral joint ⊂ knee joint", source: "SNOMED CT SUBSET" },
          { name: "RULE", text: "Avoid deep knee flexion under load", source: "CONTRAINDICATION EDGE" },
          { name: "WORKOUT", text: "Dumbbell Goblet Split Squat removed", source: "SAFETY LAYER · DETERMINISTIC" },
        ],
      },
      jumps: {
        kind: "SAFETY EXCLUSION",
        lanes: [
          { name: "MEMBER", text: `${injury.region} pain · ${injury.status}`, source: "INJURY REPORT · 05/10" },
          { name: "ANATOMY", text: "knee joint + modeled substructures", source: "SNOMED CT SUBSET" },
          { name: "RULE", text: "Avoid plyometric loading", source: "CONTRAINDICATION EDGE" },
          { name: "WORKOUT", text: "Static Jump removed; Step-Up selected", source: "SUBSTITUTION EDGE" },
        ],
      },
      deadlifts: {
        kind: "PREFERENCE",
        lanes: [
          { name: "MEMBER", text: "Dislikes: deadlifts, burpees", source: "MEMBER PREFERENCES" },
          { name: "ANATOMY", text: "No anatomy restriction", source: "—" },
          { name: "RULE", text: "Explicit preference exclusion", source: "EQUIVALENCE SET" },
          { name: "WORKOUT", text: "Deadlift variations hidden", source: "PREFERENCE FILTER" },
        ],
      },
      "box-squat": {
        kind: "SELECTION",
        lanes: [
          { name: "MEMBER", text: "Lower-body strength goal + pain-free box squats", source: "GOALS · WORKOUT LOG 06/03" },
          { name: "ANATOMY", text: "Limited flexion range at knee joint", source: "SNOMED CT SUBSET" },
          { name: "RULE", text: "Prefer knee-safe squat patterns while recovering", source: "GRADED-RETURN RULE" },
          { name: "WORKOUT", text: "Box Goblet Squat 3×10 selected", source: "COMPOSER · EQUIPMENT" },
        ],
      },
    },
    copilotCards,
    history: memberContext.workout_history,
  };
}

function lastSessionLabel(member: CoachDashboardMemberViewModel) {
  const lastSession = member.history[0];
  return `${shortDate(lastSession.date)} · ${lastSession.title}`;
}

function summaryForMember(
  member: CoachDashboardMemberViewModel,
  sessions: CoachSession[],
): CoachAthleteSummary {
  const nextSession = sessions.find((session) => session.athleteId === member.member.id) ?? null;
  return {
    id: member.member.id,
    name: member.member.name,
    initials: member.member.initials,
    tier: member.member.tier,
    adherence: member.metrics.adherence,
    suggestedWorkoutTitle: member.workoutTitle,
    lastSessionLabel: lastSessionLabel(member),
    nextSessionId: nextSession?.id ?? null,
    nextSessionLabel: nextSession ? `${shortDate(nextSession.startsAt)} · ${nextSession.label}` : null,
    nextSessionAt: nextSession?.startsAt ?? null,
  };
}

export function sessionDateKey(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(new Date(value));
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

export function buildTodayProjection(
  workspace: CoachDashboardWorkspace,
  selectedDate: string,
): CoachTodayProjection {
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

export function buildCoachWorkspace(
  members: CoachDashboardMemberViewModel[],
  sessions: CoachSession[],
): CoachDashboardWorkspace {
  const sortedSessions = [...sessions].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const memberViews = Object.fromEntries(members.map((member) => [member.member.id, member]));
  const missingAthlete = sortedSessions.find((session) => !memberViews[session.athleteId]);
  if (missingAthlete) {
    throw new Error(`Session ${missingAthlete.id} references unknown athlete ${missingAthlete.athleteId}.`);
  }
  const referenceMember = members[0];
  const timezone = "America/Chicago";
  const coachDayDate = sortedSessions[0]
    ? sessionDateKey(sortedSessions[0].startsAt, timezone)
    : referenceMember?.history[0]?.date ?? "2026-07-08";
  return {
    coach: referenceMember?.coach ?? { name: "Coach" },
    asOfDate: {
      weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${coachDayDate}T00:00:00Z`)).toUpperCase(),
      monthDay: shortDate(coachDayDate).toUpperCase(),
    },
    coachDayDate,
    timezone,
    athletes: members.map((member) => summaryForMember(member, sortedSessions)),
    sessions: sortedSessions,
    memberViews,
  };
}

const jordanFixture = buildDashboardFixture(memberContextData, exercisesData);
const averyFixture = buildDashboardFixture(averyMemberContextData, exercisesData);
const noSessionFixture = buildDashboardFixture(morganMemberContextData, exercisesData);
const coachSessions: CoachSession[] = coachSessionsData.map((session) => {
  if (session.status !== "upcoming") throw new Error(`Unsupported coach session status: ${session.status}`);
  return { ...session, status: "upcoming" };
});
const dashboardWorkspace = buildCoachWorkspace([jordanFixture, averyFixture, noSessionFixture], coachSessions);

function compileFixtureFullGraphs() {
  const movement = compileDefaultMovementGraph();
  if (movement.status !== "valid") throw new Error(JSON.stringify(movement.report));
  const memberSources = [
    { source: memberContextData, sourceLocator: "data/member-context.json" },
    { source: averyMemberContextData, sourceLocator: "data/member-context-avery.json" },
    { source: morganMemberContextData, sourceLocator: "data/member-context-morgan.json" },
  ] as const;
  const memberSnapshots = memberSources.map(({ source, sourceLocator }) => (
    compileMemberContextGraph(source, { sourceLocator })
  ));
  return {
    movement: projectMovementGraphSnapshot(movement.snapshot, "fixture"),
    members: new Map(memberSnapshots.map((snapshot) => [
      snapshot.memberId,
      projectMemberContextGraphSnapshot(snapshot, "fixture"),
    ])),
  };
}

let fixtureFullGraphs: ReturnType<typeof compileFixtureFullGraphs> | null = null;

function getFixtureFullGraphs(): ReturnType<typeof compileFixtureFullGraphs> {
  return fixtureFullGraphs ??= compileFixtureFullGraphs();
}

function fixtureFullGraphUnavailable(domain: DashboardFullGraphRequest["domain"]): FullGraphReadResult {
  return {
    status: "unavailable",
    domain,
    message: domain === "movement-clinical" ? "Movement graph fixture is unavailable." : "Member context fixture is unavailable.",
  };
}

const fixtureFullGraphClient: DashboardFullGraphClient = {
  async read(input) {
    if (input.signal?.aborted) return fixtureFullGraphUnavailable(input.domain);
    const graphs = getFixtureFullGraphs();
    const projection = input.domain === "movement-clinical"
      ? graphs.movement
      : input.memberId ? graphs.members.get(input.memberId) : undefined;
    if (!projection) return fixtureFullGraphUnavailable(input.domain);
    if (input.revisionId && input.revisionId !== projection.revisionId) {
      return {
        status: "stale",
        domain: input.domain,
        requestedRevisionId: input.revisionId,
        activeRevisionId: projection.revisionId,
      };
    }
    if (input.entityId) {
      const collection = input.entityKind === "node" ? projection.nodes : projection.relationships;
      if (!collection.some((entity) => entity.id === input.entityId)) {
        return { status: "invalid", domain: input.domain, message: "Requested graph entity is unavailable." };
      }
    }
    return { status: "ready", data: projection };
  },
};

export const dashboardFixture: CoachDashboardViewModel = {
  ...jordanFixture,
  workspace: dashboardWorkspace,
};

export const fixtureDashboardAdapter: DashboardAdapter = {
  initialState: { status: "ready", data: dashboardFixture },
  async load() {
    return { status: "ready", data: dashboardFixture };
  },
  capabilities: {
    startNewDraft: {
      available: false,
      reason: "New drafts require a connected coaching service.",
    },
    fullGraph: {
      available: true,
      client: fixtureFullGraphClient,
      supports: (input) => input.domain === "movement-clinical"
        ? input.memberId === undefined
        : typeof input.memberId === "string" && getFixtureFullGraphs().members.has(input.memberId),
    },
  },
};
