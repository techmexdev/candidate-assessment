export const COPILOT_QUESTION_MAX_LENGTH = 500;

const OVER_LIMIT_MESSAGE = "Shorten the dictated question before submitting.";
const REVIEW_MESSAGE = "Review the dictated question before submitting.";

export type SpeechCaptureStatus =
  | "idle"
  | "disclosure"
  | "requesting-permission"
  | "listening"
  | "reviewing"
  | "submitting"
  | "cancelled"
  | "unsupported"
  | "denied"
  | "no-speech"
  | "audio-error"
  | "network-error"
  | "service-error"
  | "language-error"
  | "over-limit";

export type SpeechCaptureScope = {
  readonly memberId: string;
  readonly routeId: string;
  readonly contextRevisionId: string | null;
  readonly captureId: string;
};

export type SpeechCaptureState = {
  readonly status: SpeechCaptureStatus;
  readonly scope: SpeechCaptureScope | null;
  readonly interimTranscript: string;
  readonly transcript: string;
  readonly message: string;
};

export type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly transcript: string;
};

export type SpeechRecognitionResultEventLike = {
  readonly results: readonly SpeechRecognitionResultLike[];
};

export type SpeechRecognitionErrorEventLike = {
  readonly error: string;
};

export type SpeechRecognitionLike = {
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type SpeechInputController = {
  readonly getSnapshot: () => SpeechCaptureState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly showDisclosure: (scope: SpeechCaptureScope) => void;
  readonly start: (scope: SpeechCaptureScope) => boolean;
  readonly setTranscript: (scope: SpeechCaptureScope, transcript: string) => boolean;
  readonly submit: (scope: SpeechCaptureScope) => { readonly kind: "free-text"; readonly question: string } | null;
  readonly cancel: () => void;
  readonly clear: () => void;
  readonly dispose: () => void;
};

type BrowserRecognitionResult = {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript?: string };
};

type BrowserRecognitionEvent = {
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserRecognitionResult;
  };
};

type BrowserRecognition = {
  onstart: (() => void) | null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  continuous?: boolean;
  interimResults?: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserRecognitionConstructor = new () => BrowserRecognition;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sameScope(left: SpeechCaptureScope | null, right: SpeechCaptureScope): boolean {
  return Boolean(left)
    && left!.memberId === right.memberId
    && left!.routeId === right.routeId
    && left!.contextRevisionId === right.contextRevisionId
    && left!.captureId === right.captureId;
}

function appendTranscript(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  return current + (/\s$/.test(current) || /^\s/.test(next) ? "" : " ") + next;
}

function mapBrowserError(error: string): SpeechCaptureStatus {
  switch (error) {
    case "not-allowed":
    case "permission-denied":
      return "denied";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "audio-error";
    case "network":
      return "network-error";
    case "language-not-supported":
      return "language-error";
    case "aborted":
      return "cancelled";
    default:
      return "service-error";
  }
}

function statusMessage(status: SpeechCaptureStatus): string {
  switch (status) {
    case "unsupported":
      return "Voice input is unavailable in this browser. You can type your question instead.";
    case "denied":
      return "Microphone permission was not granted. You can type your question instead.";
    case "no-speech":
      return "No speech was detected. Try again or type your question.";
    case "audio-error":
      return "The microphone could not be used. You can type your question instead.";
    case "network-error":
    case "service-error":
    case "language-error":
      return "Voice input could not be completed. You can type your question instead.";
    case "cancelled":
      return "Voice input cancelled. You can type your question.";
    case "over-limit":
      return OVER_LIMIT_MESSAGE;
    case "reviewing":
      return REVIEW_MESSAGE;
    default:
      return "";
  }
}

export function createInitialSpeechCaptureState(): SpeechCaptureState {
  return {
    status: "idle",
    scope: null,
    interimTranscript: "",
    transcript: "",
    message: "",
  };
}

function createBrowserRecognizer(): SpeechRecognitionLike | null {
  if (typeof globalThis === "undefined") return null;
  const root = globalThis as typeof globalThis & {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  };
  const Constructor = root.SpeechRecognition ?? root.webkitSpeechRecognition;
  if (!Constructor) return null;

  const browserRecognizer = new Constructor();
  const recognizer: SpeechRecognitionLike = {
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    start() {
      browserRecognizer.onstart = () => recognizer.onstart?.();
      browserRecognizer.onresult = (event) => {
        const results: SpeechRecognitionResultLike[] = [];
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          results.push({
            isFinal: result.isFinal,
            transcript: result[0]?.transcript ?? "",
          });
        }
        recognizer.onresult?.({ results });
      };
      browserRecognizer.onerror = (event) => recognizer.onerror?.(event);
      browserRecognizer.onend = () => recognizer.onend?.();
      browserRecognizer.continuous = true;
      browserRecognizer.interimResults = true;
      browserRecognizer.start();
    },
    stop: () => browserRecognizer.stop(),
    abort: () => browserRecognizer.abort(),
  };
  return recognizer;
}

export function createSpeechInputController(options: {
  readonly createRecognizer?: () => SpeechRecognitionLike | null;
} = {}): SpeechInputController {
  const createRecognizer = options.createRecognizer ?? createBrowserRecognizer;
  const listeners = new Set<() => void>();
  let snapshot = createInitialSpeechCaptureState();
  let recognizer: SpeechRecognitionLike | null = null;
  let activeScope: SpeechCaptureScope | null = null;
  let finalResultIndexes = new Set<number>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setSnapshot = (next: SpeechCaptureState) => {
    snapshot = next;
    notify();
  };

  const detachRecognizer = (abort: boolean) => {
    const current = recognizer;
    recognizer = null;
    if (!current) return;
    current.onstart = null;
    current.onresult = null;
    current.onerror = null;
    current.onend = null;
    if (abort) current.abort();
  };

  const showDisclosure = (scope: SpeechCaptureScope) => {
    detachRecognizer(true);
    activeScope = scope;
    finalResultIndexes = new Set();
    setSnapshot({ ...createInitialSpeechCaptureState(), status: "disclosure", scope });
  };

  const start = (scope: SpeechCaptureScope): boolean => {
    if (snapshot.status !== "disclosure" || !sameScope(snapshot.scope, scope)) return false;
    const nextRecognizer = createRecognizer();
    activeScope = scope;
    finalResultIndexes = new Set();
    if (!nextRecognizer) {
      setSnapshot({ ...snapshot, status: "unsupported", scope, message: statusMessage("unsupported") });
      return false;
    }

    recognizer = nextRecognizer;
    setSnapshot({ ...snapshot, status: "requesting-permission", scope, message: "" });
    nextRecognizer.onstart = () => {
      if (!recognizer || !sameScope(activeScope, scope)) return;
      setSnapshot({ ...snapshot, status: "listening", scope, message: "" });
    };
    nextRecognizer.onresult = (event) => {
      if (!recognizer || !sameScope(activeScope, scope)) return;
      let transcript = snapshot.transcript;
      let interimTranscript = "";
      let overLimit = false;
      event.results.forEach((result, index) => {
        const text = result.transcript;
        if (!text) return;
        if (result.isFinal) {
          if (finalResultIndexes.has(index)) return;
          finalResultIndexes.add(index);
          transcript = appendTranscript(transcript, text);
        } else {
          interimTranscript = appendTranscript(interimTranscript, text);
        }
        overLimit ||= codePointLength(result.isFinal ? transcript : appendTranscript(transcript, interimTranscript))
          > COPILOT_QUESTION_MAX_LENGTH;
      });
      const status: SpeechCaptureStatus = overLimit
        ? "over-limit"
        : transcript
          ? "reviewing"
          : "listening";
      setSnapshot({
        ...snapshot,
        status,
        scope,
        interimTranscript,
        transcript,
        message: statusMessage(status),
      });
    };
    nextRecognizer.onerror = (event) => {
      if (!recognizer || !sameScope(activeScope, scope)) return;
      const status = mapBrowserError(event.error);
      detachRecognizer(false);
      setSnapshot({ ...snapshot, status, scope, interimTranscript: "", message: statusMessage(status) });
    };
    nextRecognizer.onend = () => {
      if (!recognizer || !sameScope(activeScope, scope)) return;
      detachRecognizer(false);
      if (snapshot.status === "listening" || snapshot.status === "requesting-permission") {
        const status = snapshot.transcript ? "reviewing" : "no-speech";
        setSnapshot({ ...snapshot, status, scope, message: statusMessage(status) });
      }
    };
    try {
      nextRecognizer.start();
      return true;
    } catch {
      detachRecognizer(false);
      setSnapshot({ ...snapshot, status: "service-error", scope, message: statusMessage("service-error") });
      return false;
    }
  };

  const setTranscript = (scope: SpeechCaptureScope, transcript: string): boolean => {
    if (!sameScope(activeScope, scope) && !sameScope(snapshot.scope, scope)) return false;
    const status: SpeechCaptureStatus = codePointLength(transcript) > COPILOT_QUESTION_MAX_LENGTH
      ? "over-limit"
      : "reviewing";
    setSnapshot({
      ...snapshot,
      status,
      scope,
      interimTranscript: "",
      transcript,
      message: statusMessage(status),
    });
    return true;
  };

  const submit = (scope: SpeechCaptureScope) => {
    if (
      !sameScope(snapshot.scope, scope)
      || snapshot.status !== "reviewing"
      || !snapshot.transcript.trim()
      || codePointLength(snapshot.transcript) > COPILOT_QUESTION_MAX_LENGTH
    ) return null;
    setSnapshot({ ...snapshot, status: "submitting", message: "" });
    return { kind: "free-text" as const, question: snapshot.transcript };
  };

  const cancel = () => {
    detachRecognizer(true);
    setSnapshot({
      ...snapshot,
      status: "cancelled",
      interimTranscript: "",
      transcript: "",
      message: statusMessage("cancelled"),
    });
  };

  const clear = () => {
    detachRecognizer(true);
    activeScope = null;
    finalResultIndexes = new Set();
    setSnapshot(createInitialSpeechCaptureState());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showDisclosure,
    start,
    setTranscript,
    submit,
    cancel,
    clear,
    dispose: () => {
      clear();
      listeners.clear();
    },
  };
}
