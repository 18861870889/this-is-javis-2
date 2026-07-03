export const SPEECH_CONFIDENCE_THRESHOLD = 0.68;
export const MAX_SPEECH_TEXT_LENGTH = 180;

export function createBrowserSpeechInput(windowRef = globalThis.window) {
  const Recognition = windowRef?.SpeechRecognition ?? windowRef?.webkitSpeechRecognition;
  if (!Recognition) return unsupportedInput();

  let recognition = null;
  let active = false;
  return {
    supported: true,
    start({ lang = "zh-CN", onResult, onError, onEnd } = {}) {
      if (active) return false;
      recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      active = true;
      recognition.onresult = (event) => {
        const result = readRecognitionEvent(event);
        if (result.transcript) onResult?.(result);
      };
      recognition.onerror = (event) => {
        active = false;
        onError?.(normalizeSpeechError(event?.error));
      };
      recognition.onend = () => {
        active = false;
        onEnd?.();
      };
      try {
        recognition.start();
        return true;
      } catch (error) {
        active = false;
        onError?.({ code: "speech_start_failed", message: error?.message || "语音输入启动失败" });
        return false;
      }
    },
    stop() {
      if (!recognition || !active) return false;
      recognition.stop();
      active = false;
      return true;
    },
    isActive() {
      return active;
    },
  };
}

export function createBrowserSpeechOutput(windowRef = globalThis.window) {
  const synthesis = windowRef?.speechSynthesis;
  const Utterance = windowRef?.SpeechSynthesisUtterance;
  if (!synthesis || !Utterance) return unsupportedOutput();

  let lastKey = null;
  return {
    supported: true,
    speak(text, { lang = "zh-CN", volume = 1, rate = 1, key, onStart, onEnd, onError } = {}) {
      const normalized = normalizeSpeechText(text);
      if (!normalized || (key && key === lastKey)) return false;
      synthesis.cancel();
      const utterance = new Utterance(normalized);
      utterance.lang = lang;
      utterance.volume = clamp(volume, 0, 1);
      utterance.rate = clamp(rate, 0.6, 1.6);
      utterance.onstart = () => onStart?.();
      utterance.onend = () => onEnd?.();
      utterance.onerror = (event) => onError?.(normalizeSpeechError(event?.error));
      try {
        synthesis.speak(utterance);
        lastKey = key ?? normalized;
        return true;
      } catch (error) {
        onError?.({ code: "speech_output_failed", message: error?.message || "语音播报启动失败" });
        return false;
      }
    },
    stop() {
      synthesis.cancel();
    },
  };
}

export function assessSpeechTranscript({ transcript, confidence, isFinal } = {}) {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) {
    return { ok: false, code: "empty_transcript", transcript: "", confidence: normalizeConfidence(confidence) };
  }
  if (!isFinal) {
    return { ok: false, code: "interim_transcript", transcript: normalized, confidence: normalizeConfidence(confidence) };
  }
  const normalizedConfidence = normalizeConfidence(confidence);
  if (normalizedConfidence < SPEECH_CONFIDENCE_THRESHOLD) {
    return { ok: false, code: "low_confidence", transcript: normalized, confidence: normalizedConfidence };
  }
  return { ok: true, code: "ready", transcript: normalized, confidence: normalizedConfidence };
}

export function normalizeSpeechText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEECH_TEXT_LENGTH);
}

function readRecognitionEvent(event) {
  const index = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
  const result = event?.results?.[index];
  const alternative = result?.[0];
  return {
    transcript: normalizeTranscript(alternative?.transcript),
    confidence: normalizeConfidence(alternative?.confidence),
    isFinal: Boolean(result?.isFinal),
  };
}

function normalizeTranscript(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeSpeechError(code) {
  if (code === "not-allowed" || code === "service-not-allowed") return { code: "permission_denied", message: "麦克风权限未开启" };
  if (code === "no-speech") return { code: "no_speech", message: "没有检测到语音" };
  if (code === "audio-capture") return { code: "audio_unavailable", message: "无法使用麦克风" };
  return { code: code || "speech_error", message: "语音服务暂时不可用" };
}

function unsupportedInput() {
  return {
    supported: false,
    start() { return false; },
    stop() { return false; },
    isActive() { return false; },
  };
}

function unsupportedOutput() {
  return {
    supported: false,
    speak() { return false; },
    stop() {},
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
