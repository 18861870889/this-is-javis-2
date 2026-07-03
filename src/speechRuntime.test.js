import { describe, expect, it, vi } from "vitest";
import {
  assessSpeechTranscript,
  createBrowserSpeechInput,
  createBrowserSpeechOutput,
  normalizeSpeechText,
} from "./speechRuntime.js";

describe("speech runtime", () => {
  it("blocks empty, interim, and low-confidence transcripts", () => {
    expect(assessSpeechTranscript({ transcript: "", confidence: 1, isFinal: true }).code).toBe("empty_transcript");
    expect(assessSpeechTranscript({ transcript: "打开灯", confidence: 0.9, isFinal: false }).code).toBe("interim_transcript");
    expect(assessSpeechTranscript({ transcript: "打开灯", confidence: 0.4, isFinal: true })).toMatchObject({
      ok: false,
      code: "low_confidence",
    });
  });

  it("accepts a final high-confidence transcript", () => {
    expect(assessSpeechTranscript({ transcript: "  打开客厅灯  ", confidence: 0.91, isFinal: true })).toEqual({
      ok: true,
      code: "ready",
      transcript: "打开客厅灯",
      confidence: 0.91,
    });
  });

  it("uses a replaceable browser STT provider", () => {
    class Recognition {
      start = vi.fn();
      stop = vi.fn();
    }
    const input = createBrowserSpeechInput({ SpeechRecognition: Recognition });
    expect(input.supported).toBe(true);
    expect(input.start()).toBe(true);
    expect(input.isActive()).toBe(true);
    expect(input.stop()).toBe(true);
  });

  it("deduplicates TTS output and truncates long responses", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    class Utterance {
      constructor(text) { this.text = text; }
    }
    const output = createBrowserSpeechOutput({ speechSynthesis: { speak, cancel }, SpeechSynthesisUtterance: Utterance });

    expect(output.speak("状态正常", { key: "message-1" })).toBe(true);
    expect(output.speak("状态正常", { key: "message-1" })).toBe(false);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(normalizeSpeechText("a".repeat(300))).toHaveLength(180);
  });

  it("degrades safely when browser speech APIs are unavailable", () => {
    expect(createBrowserSpeechInput({}).supported).toBe(false);
    expect(createBrowserSpeechOutput({}).supported).toBe(false);
  });

  it("recovers when a browser speech provider throws synchronously", () => {
    class BrokenRecognition {
      start() { throw new Error("provider down"); }
    }
    const onError = vi.fn();
    const input = createBrowserSpeechInput({ SpeechRecognition: BrokenRecognition });

    expect(input.start({ onError })).toBe(false);
    expect(input.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "speech_start_failed" }));

    const speak = vi.fn(() => { throw new Error("output down"); });
    class Utterance { constructor(text) { this.text = text; } }
    const outputError = vi.fn();
    const output = createBrowserSpeechOutput({ speechSynthesis: { speak, cancel: vi.fn() }, SpeechSynthesisUtterance: Utterance });
    expect(output.speak("测试", { key: "retryable", onError: outputError })).toBe(false);
    expect(output.speak("测试", { key: "retryable", onError: outputError })).toBe(false);
    expect(speak).toHaveBeenCalledTimes(2);
  });
});
