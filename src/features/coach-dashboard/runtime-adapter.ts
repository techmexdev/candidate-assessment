import type { WorkoutRunResource } from "../../application/use-cases/retrieve-workout-run";
import { workoutDecisionWasSelected, type WorkoutDecision } from "../../domain/contracts/workout-provenance";
import type { WorkoutDose, WorkoutSectionKind } from "../../domain/contracts/workout";
import type { DashboardDecisionId, DashboardWorkoutItem } from "./dashboard-contract";

export type DashboardRuntimeWorkoutProjection = {
  readonly runId: string;
  readonly workoutVersionId: string;
  readonly version: number;
  readonly title: string;
  readonly durationMinutes: number;
  readonly workoutSections: readonly { readonly title: string; readonly items: readonly DashboardWorkoutItem[] }[];
  readonly exclusions: readonly (DashboardWorkoutItem & {
    readonly decisionId: DashboardDecisionId;
    readonly reason: string;
    readonly overridable: boolean;
  })[];
  readonly decisions: readonly {
    readonly id: string;
    readonly kind: WorkoutDecision["kind"];
    readonly selectionDisposition?: WorkoutDecision["selectionDisposition"];
    readonly safetyClassification?: WorkoutDecision["safetyClassification"];
    readonly exerciseConceptId: string;
    readonly explanation: string;
  }[];
  readonly decisionPaths: Readonly<Record<string, {
    readonly kind: string;
    readonly lanes: readonly { readonly name: string; readonly text: string; readonly source: string }[];
  }>>;
};

export type DashboardRuntimeEvent = {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "queued" | "claimed" | "heartbeat" | "stage" | "awaiting-clarification" | "clarification-answered" | "failed" | "canceled" | "completed";
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
};

export type DashboardWorkoutRuntimeClient = {
  readonly submit: (input: DashboardWorkoutGenerationInput, signal?: AbortSignal) => Promise<{ readonly runId: string; readonly replayed: boolean }>;
  readonly replay: (input: { readonly runId: string; readonly memberId: string; readonly cursor?: string; readonly signal?: AbortSignal }) => Promise<{ readonly cursor: string; readonly events: readonly DashboardRuntimeEvent[] }>;
  readonly read: (input: { readonly runId: string; readonly memberId: string; readonly signal?: AbortSignal }) => Promise<WorkoutRunResource>;
};

export type DashboardWorkoutGenerationInput = {
  readonly memberId: string;
  readonly prompt: string;
  readonly durationMinutes: number;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
};

export type DashboardWorkoutRuntimeUpdate =
  | { readonly status: "submitting"; readonly message: string }
  | { readonly status: "queued" | "running"; readonly runId: string; readonly message: string }
  | { readonly status: "awaiting-clarification"; readonly runId: string; readonly message: string }
  | { readonly status: "no-safe-result" | "failed" | "canceled" | "disconnected"; readonly runId?: string; readonly message: string }
  | { readonly status: "completed"; readonly runId: string; readonly message: string; readonly projection: DashboardRuntimeWorkoutProjection };

export type DashboardWorkoutRuntimeResult = Extract<DashboardWorkoutRuntimeUpdate,
  { readonly status: "completed" | "awaiting-clarification" | "no-safe-result" | "failed" | "canceled" | "disconnected" }>;

export type DashboardWorkoutRuntime = {
  readonly generate: (
    input: DashboardWorkoutGenerationInput,
    onUpdate: (update: DashboardWorkoutRuntimeUpdate) => void,
  ) => Promise<DashboardWorkoutRuntimeResult>;
};

const sectionTitle: Record<WorkoutSectionKind, string> = {
  "warm-up": "Warm-up",
  main: "Main",
  "cool-down": "Cool-down",
};

function formatDose(dose: WorkoutDose): string {
  return dose.kind === "timed"
    ? `${dose.sets}×${dose.workSecondsPerSet} sec`
    : `${dose.sets}×${dose.repetitionsPerSet}`;
}

function pathForDecision(decision: WorkoutDecision) {
  return {
    kind: decision.kind,
    lanes: [
      { name: "Decision", text: decision.explanation, source: String(decision.decisionId) },
      {
        name: "Graph path",
        text: "Stored contributing paths used for this decision.",
        source: decision.contributingPathIds.join(" · "),
      },
      {
        name: "Evidence",
        text: "Stored assertions and evidence used for this decision.",
        source: [...decision.sourceAssertionIds, ...decision.evidenceIds].join(" · "),
      },
      {
        name: "Pinned revisions",
        text: "Historical trace resolved from the run's immutable revisions.",
        source: `${decision.movementGraphRevisionId} · ${decision.memberContextRevisionId}`,
      },
    ],
  } as const;
}

function decisionPriority(decision: WorkoutDecision): number {
  return ({ cautioned: 0, downranked: 1, substituted: 2, selected: 3, "not-selected": 4, excluded: 5 } as const)[decision.kind];
}

/** Projects only the stored immutable workout and trace; it never reconstructs reasons from active state. */
export function projectWorkoutRunResource(resource: WorkoutRunResource): DashboardRuntimeWorkoutProjection {
  if (resource.state !== "completed" || !resource.workout || !resource.provenance) {
    throw new Error("A completed workout and provenance trace are required for dashboard projection.");
  }
  const workout = resource.workout;
  const decisions = [...resource.provenance.decisions];
  const decisionsByExercise = new Map<string, WorkoutDecision[]>();
  for (const decision of decisions) {
    const existing = decisionsByExercise.get(decision.exerciseConceptId) ?? [];
    existing.push(decision);
    decisionsByExercise.set(decision.exerciseConceptId, existing);
  }
  const workoutSections = workout.workout.sections.map((section) => ({
    title: sectionTitle[section.kind],
    items: section.items.map((item, index): DashboardWorkoutItem => {
      const decision = [...(decisionsByExercise.get(item.exerciseConceptId) ?? [])]
        .filter(workoutDecisionWasSelected)
        .sort((left, right) => decisionPriority(left) - decisionPriority(right))[0];
      return {
        id: `${section.kind}:${item.exerciseConceptId}:${index}`,
        name: item.exerciseConceptId,
        catalogName: item.exerciseConceptId,
        catalogId: item.exerciseConceptId,
        dose: formatDose(item.dose),
        rest: item.restSeconds > 0 ? `${item.restSeconds} sec rest` : "No planned rest",
        why: item.rationale,
        provenance: decision
          ? [...decision.sourceAssertionIds, ...decision.contributingPathIds, ...decision.evidenceIds].join(" · ")
          : `${resource.movementGraphRevisionId} · ${resource.memberContextRevisionId}`,
        ...(decision ? { decisionId: String(decision.decisionId) } : {}),
      };
    }),
  }));
  const exclusions = decisions
    .filter((decision) => decision.kind === "excluded")
    .map((decision): DashboardRuntimeWorkoutProjection["exclusions"][number] => ({
      id: `excluded:${decision.decisionId}`,
      name: decision.exerciseConceptId,
      catalogName: decision.exerciseConceptId,
      catalogId: decision.exerciseConceptId,
      dose: "Excluded",
      rest: "Not scheduled",
      why: decision.explanation,
      reason: decision.explanation,
      provenance: [...decision.sourceAssertionIds, ...decision.contributingPathIds, ...decision.evidenceIds].join(" · "),
      decisionId: String(decision.decisionId),
      overridable: false,
    }));
  return Object.freeze({
    runId: String(resource.runId),
    workoutVersionId: String(workout.workoutVersionId),
    version: workout.version,
    title: "Generated workout",
    durationMinutes: resource.requestedDurationMinutes,
    workoutSections,
    exclusions,
    decisions: decisions.map((decision) => ({
      id: String(decision.decisionId),
      kind: decision.kind,
      ...(decision.selectionDisposition ? { selectionDisposition: decision.selectionDisposition } : {}),
      ...(decision.safetyClassification ? { safetyClassification: decision.safetyClassification } : {}),
      exerciseConceptId: decision.exerciseConceptId,
      explanation: decision.explanation,
    })),
    decisionPaths: Object.fromEntries(decisions.map((decision) => [String(decision.decisionId), pathForDecision(decision)])),
  });
}

const terminalFailure = (runId: string, data: DashboardRuntimeEvent["data"]): DashboardWorkoutRuntimeResult => {
  const kind = typeof data.kind === "string" ? data.kind : "runtime-failure";
  const noSafeResult = kind === "no-safe-candidates" || kind === "no-safe-result" || kind === "no-eligible-candidates";
  return noSafeResult
    ? { status: "no-safe-result", runId, message: "No safe workout could be generated. Adjust the request or member context." }
    : { status: "failed", runId, message: "Workout generation failed. Try again with a new request." };
};

export function createDashboardWorkoutRuntime(
  client: DashboardWorkoutRuntimeClient,
  options: { readonly wait?: () => Promise<void>; readonly maximumReconnects?: number } = {},
): DashboardWorkoutRuntime {
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
  const maximumReconnects = options.maximumReconnects ?? 3;
  return {
    async generate(input, onUpdate) {
      onUpdate({ status: "submitting", message: "Submitting workout request…" });
      let runId: string | undefined;
      try {
        const submitted = await client.submit(input, input.signal);
        runId = submitted.runId;
        let cursor: string | undefined;
        let reconnects = 0;
        const seenEvents = new Set<string>();
        while (!input.signal?.aborted) {
          let replay;
          try {
            replay = await client.replay({ runId, memberId: input.memberId, ...(cursor ? { cursor } : {}), ...(input.signal ? { signal: input.signal } : {}) });
            reconnects = 0;
          } catch {
            reconnects += 1;
            const disconnected = { status: "disconnected", runId, message: "Connection interrupted. Reconnecting…" } as const;
            onUpdate(disconnected);
            if (reconnects > maximumReconnects) return disconnected;
            await wait();
            continue;
          }
          cursor = replay.cursor || cursor;
          let sawNewEvent = false;
          for (const event of [...replay.events].sort((left, right) => left.sequence - right.sequence)) {
            if (seenEvents.has(event.eventId)) continue;
            seenEvents.add(event.eventId);
            sawNewEvent = true;
            if (event.kind === "queued") onUpdate({ status: "queued", runId, message: "Workout generation queued." });
            if (event.kind === "claimed" || event.kind === "heartbeat" || event.kind === "clarification-answered" || event.kind === "stage") {
              const stage = typeof event.data.stage === "string" ? `: ${event.data.stage}` : "";
              onUpdate({ status: "running", runId, message: `Generating workout${stage}…` });
            }
            if (event.kind === "awaiting-clarification") {
              const result = { status: "awaiting-clarification", runId, message: "More detail is needed before a safe workout can be generated." } as const;
              onUpdate(result);
              return result;
            }
            if (event.kind === "failed") {
              const result = terminalFailure(runId, event.data);
              onUpdate(result);
              return result;
            }
            if (event.kind === "canceled") {
              const result = { status: "canceled", runId, message: "Workout generation was canceled." } as const;
              onUpdate(result);
              return result;
            }
            if (event.kind === "completed") {
              try {
                const resource = await client.read({ runId, memberId: input.memberId, ...(input.signal ? { signal: input.signal } : {}) });
                const projection = projectWorkoutRunResource(resource);
                const result = { status: "completed", runId, message: "Generated workout and decision trace ready.", projection } as const;
                onUpdate(result);
                return result;
              } catch {
                const disconnected = { status: "disconnected", runId, message: "Workout completed, but the authoritative result could not be loaded. Reconnect to retry." } as const;
                onUpdate(disconnected);
                return disconnected;
              }
            }
          }
          if (!sawNewEvent) {
            const snapshot = await client.read({ runId, memberId: input.memberId, ...(input.signal ? { signal: input.signal } : {}) });
            if (snapshot.state === "completed") {
              const projection = projectWorkoutRunResource(snapshot);
              const result = { status: "completed", runId, message: "Generated workout and decision trace ready.", projection } as const;
              onUpdate(result);
              return result;
            }
            if (snapshot.state === "awaiting-clarification") {
              const result = { status: "awaiting-clarification", runId, message: "More detail is needed before a safe workout can be generated." } as const;
              onUpdate(result);
              return result;
            }
            if (snapshot.state === "failed") {
              const result = terminalFailure(runId, snapshot.failure ?? {});
              onUpdate(result);
              return result;
            }
            if (snapshot.state === "canceled") {
              const result = { status: "canceled", runId, message: "Workout generation was canceled." } as const;
              onUpdate(result);
              return result;
            }
          }
          await wait();
        }
      } catch {
        const result = runId
          ? { status: "disconnected", runId, message: "Connection interrupted. Reconnect to continue." } as const
          : { status: "failed", message: "Workout request could not be submitted. Try again." } as const;
        onUpdate(result);
        return result;
      }
      const result = { status: "disconnected", ...(runId ? { runId } : {}), message: "Workout updates stopped after leaving this member." } as const;
      return result;
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createFetchDashboardWorkoutRuntimeClient(fetcher: typeof fetch = fetch): DashboardWorkoutRuntimeClient {
  return {
    async submit(input, signal) {
      const response = await fetcher("/api/workout-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: input.memberId, prompt: input.prompt, durationMinutes: input.durationMinutes, idempotencyKey: input.idempotencyKey }),
        ...(signal ? { signal } : {}),
      });
      const body: unknown = await response.json();
      if (!response.ok || !isObject(body) || typeof body.runId !== "string") throw new Error("Workout submission failed.");
      return { runId: body.runId, replayed: body.status === "replayed" };
    },
    async replay(input) {
      const params = new URLSearchParams({ memberId: input.memberId });
      if (input.cursor) params.set("cursor", input.cursor);
      const response = await fetcher(`/api/workout-runs/${encodeURIComponent(input.runId)}/events?${params}`, {
        headers: { accept: "text/event-stream" },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!response.ok) throw new Error("Workout event replay failed.");
      const text = await response.text();
      const events: DashboardRuntimeEvent[] = [];
      let cursor = input.cursor ?? "";
      for (const block of text.split(/\n\n+/)) {
        const lines = block.split("\n");
        const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const kind = lines.find((line) => line.startsWith("event: "))?.slice(7) as DashboardRuntimeEvent["kind"] | undefined;
        const dataText = lines.find((line) => line.startsWith("data: "))?.slice(6);
        if (!id || !kind || !dataText) continue;
        const data: unknown = JSON.parse(dataText);
        if (!isObject(data) || typeof data.eventId !== "string" || typeof data.sequence !== "number" || typeof data.occurredAt !== "string") continue;
        const { eventId, sequence, occurredAt } = data;
        const safeData = Object.fromEntries(
          Object.entries(data).filter(([key]) => !["eventId", "sequence", "occurredAt", "runId"].includes(key)),
        );
        events.push({ eventId, sequence, kind, occurredAt, data: safeData as DashboardRuntimeEvent["data"] });
        cursor = id;
      }
      return { cursor, events };
    },
    async read(input) {
      const params = new URLSearchParams({ memberId: input.memberId });
      const response = await fetcher(`/api/workout-runs/${encodeURIComponent(input.runId)}?${params}`, {
        headers: { accept: "application/json" },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!response.ok) throw new Error("Workout resource read failed.");
      return await response.json() as WorkoutRunResource;
    },
  };
}
