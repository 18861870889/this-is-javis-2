export function createProviderSnapshot(graph) {
  const canonical = canonicalize(graph);
  return {
    hash: hashString(JSON.stringify(canonical)),
    canonical,
  };
}

export function diffHcmHomes(previousHome, nextHome) {
  if (!previousHome) {
    return nextHome.things.map((thing) => ({
      type: "thing.added",
      thingId: thing.id,
      thingName: thing.name,
    }));
  }

  const events = [];
  const previousThings = new Map(previousHome.things.map((thing) => [thing.id, thing]));
  const nextThings = new Map(nextHome.things.map((thing) => [thing.id, thing]));

  for (const [thingId, thing] of nextThings) {
    const previousThing = previousThings.get(thingId);
    if (!previousThing) {
      events.push({ type: "thing.added", thingId, thingName: thing.name });
      continue;
    }

    if (previousThing.name !== thing.name) {
      events.push({
        type: "thing.renamed",
        thingId,
        from: previousThing.name,
        to: thing.name,
      });
    }
    if (previousThing.spaceId !== thing.spaceId) {
      events.push({
        type: "thing.moved",
        thingId,
        from: previousThing.spaceId,
        to: thing.spaceId,
      });
    }

    events.push(...diffCapabilities(previousThing, thing));
  }

  for (const [thingId, thing] of previousThings) {
    if (!nextThings.has(thingId)) {
      events.push({ type: "thing.removed", thingId, thingName: thing.name });
    }
  }

  return events;
}

function diffCapabilities(previousThing, nextThing) {
  const events = [];
  const previousCaps = new Map(previousThing.capabilities.map((capability) => [capability.id, capability]));
  const nextCaps = new Map(nextThing.capabilities.map((capability) => [capability.id, capability]));

  for (const [capabilityId, capability] of nextCaps) {
    const previousCapability = previousCaps.get(capabilityId);
    if (!previousCapability) {
      events.push({
        type: "capability.added",
        thingId: nextThing.id,
        capabilityId,
        capabilityName: capability.name,
      });
      continue;
    }

    if (JSON.stringify(previousCapability.binding) !== JSON.stringify(capability.binding)) {
      events.push({
        type: "binding.changed",
        thingId: nextThing.id,
        capabilityId,
      });
    }
    if (JSON.stringify(previousCapability.state) !== JSON.stringify(capability.state)) {
      events.push({
        type: "thing.state.changed",
        thingId: nextThing.id,
        capabilityId,
        from: previousCapability.state,
        to: capability.state,
      });
    }
  }

  for (const [capabilityId, capability] of previousCaps) {
    if (!nextCaps.has(capabilityId)) {
      events.push({
        type: "capability.removed",
        thingId: nextThing.id,
        capabilityId,
        capabilityName: capability.name,
      });
    }
  }

  return events;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
