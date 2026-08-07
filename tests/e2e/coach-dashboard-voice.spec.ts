import { expect, test, type Page } from "@playwright/test";

type FakeRecognitionResult = { isFinal: boolean; transcript: string; 0?: { transcript: string } };

async function installFakeSpeech(page: Page) {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      static current: FakeSpeechRecognition | null = null;
      onstart: (() => void) | null = null;
      onresult: ((event: { results: FakeRecognitionResult[] }) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() { FakeSpeechRecognition.current = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() {}
    }

    const target = window as unknown as {
      SpeechRecognition: typeof FakeSpeechRecognition;
      __emitSpeech: (results: FakeRecognitionResult[]) => void;
      __emitSpeechError: (error: string) => void;
    };
    target.SpeechRecognition = FakeSpeechRecognition;
    target.__emitSpeech = (results) => FakeSpeechRecognition.current?.onresult?.({ results: results.map((result) => ({ ...result, 0: { transcript: result.transcript } })) });
    target.__emitSpeechError = (error) => FakeSpeechRecognition.current?.onerror?.({ error });
  });
}

async function emitSpeech(page: Page, results: FakeRecognitionResult[]) {
  await page.evaluate((nextResults) => {
    (window as unknown as { __emitSpeech: (value: FakeRecognitionResult[]) => void }).__emitSpeech(nextResults);
  }, results);
}

test("inline voice input requires disclosure, keeps text editable, and submits one Copilot request", async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await installFakeSpeech(page);
  await page.route("**/api/copilot", async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByText("Before voice input", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow microphone & start" })).toBeVisible();
  await page.getByRole("button", { name: "Allow microphone & start" }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await emitSpeech(page, [{ isFinal: false, transcript: "How is" }]);
  await emitSpeech(page, [{ isFinal: true, transcript: "How is adherence trending" }]);
  await emitSpeech(page, [{ isFinal: true, transcript: "How is adherence trending" }]);

  const input = page.getByRole("textbox", { name: "Ask about Jordan Rivera" });
  await expect(input).toHaveValue("How is adherence trending");
  await input.fill("What changed since last week?");
  const request = page.waitForRequest("**/api/copilot");
  await page.getByRole("button", { name: "Ask Copilot" }).click();
  const body = (await request).postDataJSON() as { input: unknown; memberId: string };
  expect(body).toMatchObject({ memberId: "mbr_01HX9JORDAN", input: { kind: "free-text", question: "What changed since last week?" } });
  expect(await page.getByRole("textbox", { name: "Ask about Jordan Rivera" }).inputValue()).toBe("");
  expect(requests.at(-1)).toMatchObject({ input: { kind: "free-text", question: "What changed since last week?" } });
});

test("nested voice returns a reviewed transcript to the shared Copilot composer", async ({ page }) => {
  await installFakeSpeech(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();
  const voiceTrigger = page.getByRole("button", { name: "Open voice mode" });
  await voiceTrigger.click();

  await expect(page.getByRole("region", { name: "Voice mode" })).toBeVisible();
  await page.getByRole("button", { name: "Use voice input" }).click();
  await page.getByRole("button", { name: "Allow microphone & start" }).click();
  await emitSpeech(page, [{ isFinal: true, transcript: "What changed since last week?" }]);
  await expect(page.getByRole("textbox", { name: "Review dictated question" })).toHaveValue("What changed since last week?");

  await page.getByRole("button", { name: "Go back" }).first().click();
  await expect(page.getByRole("region", { name: "Copilot" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask about Jordan Rivera" })).toHaveValue("What changed since last week?");
  await expect(voiceTrigger).toBeFocused();
});

test("voice mode remains nested and restores focus to its Copilot trigger", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Jordan Rivera morning brief" }).first().click();
  await page.getByRole("button", { name: /Copilot context/ }).click();

  const voiceTrigger = page.getByRole("button", { name: "Open voice mode" });
  await voiceTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Voice mode" })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).first().click();
  await expect(page.getByRole("region", { name: "Copilot" })).toBeVisible();
  await expect(voiceTrigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Voice", exact: true })).toHaveCount(0);
});

test("unavailable members cannot start voice capture or fabricate a task", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Avery Chen morning brief" }).first().click();
  await page.getByRole("button", { name: /Talk through today/ }).click();
  await expect(page.getByRole("region", { name: "Voice mode" })).toBeVisible();
  await expect(page.getByText("Continue in text Copilot")).toBeVisible();
  await expect(page.getByRole("button", { name: /use voice input/i })).toHaveCount(0);
  await expect(page.getByText(/Voice capture is disabled/)).toBeVisible();
  await expect(page.getByText(/No fixture|graph-backed voice answer/i)).toHaveCount(0);
});
