export async function getHcmHome() {
  const response = await fetch("/api/hcm/home");
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM request failed ${response.status}`);
  }
  return payload;
}

export async function getRuntimeStatus() {
  return fetchJson("/api/runtime/status");
}

export async function getSpatialEditorState() {
  return fetchJson("/api/spatial-editor/state");
}

export async function saveSpatialEditorState({ state, source = "browser" }) {
  return fetchJson("/api/spatial-editor/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, source }),
  });
}

export async function updateHcmBindingOverride({ providerId, entityId, action }) {
  const response = await fetch("/api/hcm/overrides/bindings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, entityId, action }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM override request failed ${response.status}`);
  }
  return payload;
}

export async function applyDefaultRunPolicy({ providerId } = {}) {
  const response = await fetch("/api/hcm/overrides/default-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM default-run request failed ${response.status}`);
  }
  return payload;
}

export async function runHcmCommand({ input, currentRoomId, selectedRoomId, sessionId, dryRun = false, source = "text" }) {
  const response = await fetch("/api/hcm/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, currentRoomId, selectedRoomId, sessionId, dryRun, source }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM command request failed ${response.status}`);
  }
  return payload;
}

export async function updateHcmThingOverride({ providerId, thingId, patch }) {
  const response = await fetch("/api/hcm/overrides/things", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, thingId, patch }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM thing override request failed ${response.status}`);
  }
  return payload;
}

export async function updateHcmControlMapping({ providerId, entityId, patch }) {
  const response = await fetch("/api/hcm/overrides/control-mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, entityId, patch }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HCM control mapping update failed ${response.status}`);
  }
  return payload;
}

export async function getCommandAudit({ limit = 8 } = {}) {
  const response = await fetch(`/api/commands/audit?limit=${encodeURIComponent(limit)}`);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Command audit request failed ${response.status}`);
  }
  return payload;
}

export async function replayCommandAudit({ commandId, currentRoomId, selectedRoomId }) {
  const response = await fetch("/api/commands/replay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId, currentRoomId, selectedRoomId }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Command replay request failed ${response.status}`);
  }
  return payload;
}

export async function getLearningMemory() {
  const response = await fetch("/api/learning/memory");
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Learning memory request failed ${response.status}`);
  }
  return payload;
}

export async function getAgentSnapshot() {
  const response = await fetch("/api/agents/snapshot");
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Agent snapshot request failed ${response.status}`);
  }
  return payload;
}

export async function getOnboardingPlan() {
  const response = await fetch("/api/onboarding/plan");
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Onboarding plan request failed ${response.status}`);
  }
  return payload;
}

export async function recordOnboardingSnapshot() {
  const response = await fetch("/api/onboarding/snapshot", { method: "POST" });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Onboarding snapshot request failed ${response.status}`);
  }
  return payload;
}

export async function updateLearningCandidate({ candidateId, status, note }) {
  const response = await fetch(`/api/learning/candidates/${encodeURIComponent(candidateId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, note }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Learning candidate update failed ${response.status}`);
  }
  return payload;
}

export async function deleteLearningCandidate({ candidateId }) {
  const response = await fetch(`/api/learning/candidates/${encodeURIComponent(candidateId)}`, {
    method: "DELETE",
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Learning candidate delete failed ${response.status}`);
  }
  return payload;
}

export async function getAutomationSuggestions() {
  return fetchJson("/api/automation/suggestions");
}

export async function captureAutomationEvents() {
  return fetchJson("/api/automation/events/capture", { method: "POST" });
}

export async function updateAutomationSuggestion({ suggestionId, status }) {
  return fetchJson(`/api/automation/suggestions/${encodeURIComponent(suggestionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export async function previewAutomationSuggestion(suggestionId) {
  return fetchJson(`/api/automation/suggestions/${encodeURIComponent(suggestionId)}/simulate`, { method: "POST" });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `Request failed ${response.status}`);
  return payload;
}
