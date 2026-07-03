const DEFAULT_SEMANTICS = [
  {
    phrase: "晾衣服",
    intent: "prepare_laundry_drying",
    targetTypes: ["drying_rack"],
    targetNames: ["晾衣杆"],
    preferredRoomNames: ["阳台"],
    defaultCapabilityNames: ["升降", "位置"],
    defaultValue: 100,
  },
  {
    phrase: "晒衣服",
    intent: "prepare_laundry_drying",
    targetTypes: ["drying_rack"],
    targetNames: ["晾衣杆"],
    preferredRoomNames: ["阳台"],
    defaultCapabilityNames: ["升降", "位置"],
    defaultValue: 100,
  },
  {
    phrase: "看电影",
    intent: "movie_mode",
    targetTypes: ["tv", "curtain", "switch_panel"],
    targetNames: ["电视", "窗帘", "灯"],
    preferredRoomNames: ["客厅"],
  },
  {
    phrase: "准备看电影",
    intent: "movie_mode",
    targetTypes: ["tv", "curtain", "switch_panel"],
    targetNames: ["电视", "窗帘", "灯"],
    preferredRoomNames: ["客厅"],
  },
  {
    phrase: "小爱音箱",
    intent: "media_control",
    targetTypes: ["tv", "speaker", "media_player"],
    targetNames: ["小爱音箱", "音箱"],
  },
  {
    phrase: "玄关人体",
    intent: "query_entry_motion",
    targetTypes: ["motion_sensor"],
    targetNames: ["入户传感器", "人体"],
    preferredRoomNames: ["玄关", "入户"],
  },
];

export function compilePersonalSemanticsForPlanner(input, home, { limit = 6 } = {}) {
  if (!home?.things?.length) return [];
  const normalizedInput = normalize(input);

  return DEFAULT_SEMANTICS.filter((rule) => normalizedInput.includes(normalize(rule.phrase)))
    .map((rule) => compileRuleHint(rule, home))
    .filter(Boolean)
    .slice(0, limit);
}

export function applyPersonalSemanticsToThingAliases(home) {
  if (!home?.things) return home;
  const hints = compileAliasHints(home);
  return {
    ...home,
    things: home.things.map((thing) => ({
      ...thing,
      aliases: Array.from(new Set([...(thing.aliases ?? []), ...(hints.get(thing.id) ?? [])])),
    })),
  };
}

function compileRuleHint(rule, home) {
  const candidates = home.things
    .map((thing) => ({
      thing,
      score: scoreThingForRule(thing, rule, home),
    }))
    .filter((candidate) => candidate.score >= 4)
    .sort((first, second) => second.score - first.score)
    .slice(0, 5)
    .map(({ thing, score }) => ({
      thingId: thing.id,
      thingName: thing.name,
      type: thing.type,
      roomId: thing.spaceId,
      confidence: Math.min(0.95, 0.45 + score * 0.08),
      suggestedCapabilities: suggestCapabilities(thing, rule),
    }));

  if (candidates.length === 0) return null;
  return {
    phrase: rule.phrase,
    intent: rule.intent,
    source: "built_in_personal_semantics",
    defaultValue: rule.defaultValue,
    candidates,
  };
}

function scoreThingForRule(thing, rule, home) {
  const text = normalize(`${thing.name} ${(thing.aliases ?? []).join(" ")} ${thing.type}`);
  const room = home.spaces?.find((space) => space.id === thing.spaceId);
  const roomText = normalize(`${room?.name ?? ""} ${(room?.aliases ?? []).join(" ")}`);
  let score = 0;

  if (rule.targetTypes?.includes(thing.type)) score += 5;
  if (rule.targetNames?.some((name) => text.includes(normalize(name)))) score += 4;
  if (rule.preferredRoomNames?.some((name) => roomText.includes(normalize(name)) || text.includes(normalize(name)))) score += 3;
  if (score > 0 && suggestCapabilities(thing, rule).length > 0) score += 2;
  return score;
}

function suggestCapabilities(thing, rule) {
  const names = rule.defaultCapabilityNames ?? [];
  return (thing.capabilities ?? [])
    .filter((capability) => capability.kind === "control" || capability.kind === "action")
    .filter((capability) => capability.policy?.autoExecutable)
    .filter((capability) => {
      if (names.length === 0) return true;
      const text = normalize(`${capability.id} ${capability.name}`);
      return names.some((name) => text.includes(normalize(name)));
    })
    .slice(0, 3)
    .map((capability) => ({
      capabilityId: capability.id,
      capabilityName: capability.name,
      defaultValue: rule.defaultValue,
    }));
}

function compileAliasHints(home) {
  const hints = new Map();
  for (const rule of DEFAULT_SEMANTICS) {
    const hint = compileRuleHint(rule, home);
    const best = hint?.candidates?.[0];
    if (!best || best.confidence < 0.75) continue;
    hints.set(best.thingId, [...(hints.get(best.thingId) ?? []), rule.phrase]);
  }
  return hints;
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?]/g, "");
}
