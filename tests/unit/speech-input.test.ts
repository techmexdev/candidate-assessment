import { describe, expect, it } from "vitest";

import {
  COPILOT_QUESTION_MAX_LENGTH,
  createInitialSpeechCaptureState,
  createSpeechInputController,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
  type SpeechCaptureScope,
} from "../../src/features/coach-dashboard/speech-input";

class FakeRecognizer implements SpeechRecognitionLike {
  onstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }

  abort() {
    this.abortCalls += 1;
  }

  emitStart() {
    this.onstart?.();
  }

  emitResult(results: SpeechRecognitionResultEventLike["results"]) {
    this.onresult?.({ results });
  }

  emitError(error: SpeechRecognitionErrorEventLike["error"]) {
    this.onerror?.({ error });
  }

  emitEnd() {
    this.onend?.();
  }
}

const scope = (captureId = "capture-1"): SpeechCaptureScope => ({
  memberId: "mbr_jordan",
  routeId: "copilot",
  contextRevisionId: "revision-1",
  captureId,
});

describe("speech input controller", () => {
  it("requires disclosure, reviews final text, deduplicates final results, and submits through free text", () => {
    const recognizer = new FakeRecognizer();
    const controller = createSpeechInputController({ createRecognizer: () => recognizer });
    const activeScope = scope();

    expect(controller.getSnapshot()).toEqual(createInitialSpeechCaptureState());
    controller.showDisclosure(activeScope);
    expect(controller.getSnapshot().status).toBe("disclosure");
    expect(controller.start(activeScope)).toBe(true);
    expect(controller.getSnapshot().status).toBe("requesting-permission");
    recognizer.emitStart();
    expect(controller.getSnapshot().status).toBe("listening");

    recognizer.emitResult([{ isFinal: false, transcript: "What changed" }]);
    expect(controller.getSnapshot().interimTranscript).toBe("What changed");
    recognizer.emitResult([{ isFinal: true, transcript: "What changed since last week?" }]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "reviewing",
      transcript: "What changed since last week?",
      interimTranscript: "",
    });
    recognizer.emitResult([{ isFinal: true, transcript: "What changed since last week?" }]);
    expect(controller.getSnapshot().transcript).toBe("What changed since last week?");

    expect(controller.submit(activeScope)).toEqual({
      kind: "free-text",
      question: "What changed since last week?",
    });
    expect(controller.getSnapshot().status).toBe("submitting");
    expect(recognizer.startCalls).toBe(1);
  });

  it("maps browser failures to safe finite states and keeps typed fallback available", () => {
    const failures = [
      ["not-allowed", "denied"],
      ["no-speech", "no-speech"],
      ["audio-capture", "audio-error"],
      ["network", "network-error"],
      ["service-not-allowed", "service-error"],
      ["language-not-supported", "language-error"],
    ] as const;

    for (const [browserError, expectedStatus] of failures) {
      const recognizer = new FakeRecognizer();
      const controller = createSpeechInputController({ createRecognizer: () => recognizer });
      const activeScope = scope(browserError);
      controller.showDisclosure(activeScope);
      expect(controller.start(activeScope)).toBe(true);
      recognizer.emitError(browserError);
      expect(controller.getSnapshot().status).toBe(expectedStatus);
      expect(controller.getSnapshot().message).not.toContain(browserError);
      expect(controller.submit(activeScope)).toBeNull();
    }

    const unsupported = createSpeechInputController({ createRecognizer: () => null });
    unsupported.showDisclosure(scope("unsupported"));
    expect(unsupported.start(scope("unsupported"))).toBe(false);
    expect(unsupported.getSnapshot().status).toBe("unsupported");
  });

  it("clears capture on cancellation and ignores late events or mismatched submit scopes", () => {
    const recognizer = new FakeRecognizer();
    const controller = createSpeechInputController({ createRecognizer: () => recognizer });
    const activeScope = scope();
    const foreignScope = { ...activeScope, memberId: "mbr_avery" };

    controller.showDisclosure(activeScope);
    controller.start(activeScope);
    recognizer.emitStart();
    recognizer.emitResult([{ isFinal: true, transcript: "Review adherence" }]);
    controller.cancel();

    expect(controller.getSnapshot()).toMatchObject({
      status: "cancelled",
      transcript: "",
      interimTranscript: "",
    });
    expect(recognizer.abortCalls).toBe(1);
    recognizer.emitResult([{ isFinal: true, transcript: "Do not retarget" }]);
    expect(controller.getSnapshot().transcript).toBe("");
    expect(controller.submit(foreignScope)).toBeNull();
  });

  it("uses a Unicode code-point bound and rejects over-limit questions without truncating or submitting", () => {
    const controller = createSpeechInputController({ createRecognizer: () => new FakeRecognizer() });
    const activeScope = scope();
    const withinLimit = "🙂".repeat(COPILOT_QUESTION_MAX_LENGTH);
    const tooLong = withinLimit + "x";

    controller.showDisclosure(activeScope);
    controller.setTranscript(activeScope, withinLimit);
    expect(controller.getSnapshot().status).toBe("reviewing");
    expect(controller.submit(activeScope)?.question).toBe(withinLimit);

    controller.showDisclosure(activeScope);
    controller.setTranscript(activeScope, tooLong);
    expect(controller.getSnapshot().status).toBe("over-limit");
    expect(controller.getSnapshot().transcript).toBe(tooLong);
    expect(controller.submit(activeScope)).toBeNull();
  });
});
