import { findExplicitRoomIds, getHcmControlGraph } from "./hcmControlGraph.js";

const INVENTORY_PATTERN = /几个|多少个|有哪些|有什么|列出|数量|设备清单/;
const CAPABILITY_QUERY_PATTERN = /如何控制|怎么控制|怎样控制|怎么用|能做什么|可控制|控制功能|支持.*(什么|哪些)|有哪些.*(能力|功能|操作|控制)/;

export function looksLikeInventoryQuery(input) {
  const text = String(input ?? "");
  return INVENTORY_PATTERN.test(text) || CAPABILITY_QUERY_PATTERN.test(text);
}

export function looksLikeCapabilityQuery(input) {
  return CAPABILITY_QUERY_PATTERN.test(String(input ?? ""));
}

export function answerHcmCapabilityQuery(input, home, reason = "") {
  if (!looksLikeCapabilityQuery(input) || !home) return null;
  const targets = findCapabilityQueryTargets(input, home);
  if (targets.length === 0) return null;
  if (targets.length > 1) {
    const names = targets.map((thing) => thing.name);
    return {
      path: "hcm-capability-query",
      mode: "capability_list",
      thingId: null,
      thingName: names.join("、"),
      available: true,
      count: targets.length,
      items: [],
      reason,
      summary: `我找到多个可能设备：${names.join("、")}。请说更具体的设备名。`,
    };
  }

  const thing = targets[0];
  const capabilitySummary = summarizeThingCapabilities(thing);
  const parts = [];
  if (capabilitySummary.unsupported.length > 0) {
    parts.push(`当前不能直接执行：${capabilitySummary.unsupported.join("、")}`);
  }
  if (capabilitySummary.executable.length > 0) {
    parts.push(`可直接执行：${capabilitySummary.executable.join("、")}`);
  }
  if (capabilitySummary.confirmable.length > 0) {
    parts.push(`需要确认/受保护：${capabilitySummary.confirmable.join("、")}`);
  }
  if (capabilitySummary.readable.length > 0) {
    parts.push(`可读取：${capabilitySummary.readable.join("、")}`);
  }

  return {
    path: "hcm-capability-query",
    mode: "capability_list",
    thingId: thing.id,
    thingName: thing.name,
    available: true,
    count: capabilitySummary.total,
    items: capabilitySummary.items,
    reason,
    summary: `${thing.name}：${parts.join("；") || "当前没有可展示能力"}。`,
  };
}

export function answerHcmInventoryQuery(input, home, reason = "") {
  if (!looksLikeInventoryQuery(input) || !home) return null;
  const roomIds = findExplicitRoomIds(input, home);
  const roomId = roomIds.length === 1 ? roomIds[0] : null;
  const roomName = home.spaces?.find((space) => space.id === roomId)?.name;
  const category = inferCategory(input);
  const items = inventoryItems(home)
    .filter((item) => !roomId || item.roomId === roomId)
    .filter((item) => matchesCategory(item, category));
  const scope = roomName ?? "全屋";
  const label = category.label ?? "设备";
  const names = items.map((item) => item.name);

  return {
    path: "hcm-inventory-query",
    mode: /几个|多少个|数量/.test(input) ? "count" : "list",
    thingId: null,
    thingName: `${scope}${label}`,
    roomId,
    available: true,
    count: items.length,
    items,
    reason,
    summary: `${scope}共有 ${items.length} 个${label}${names.length > 0 ? `：${names.join("、")}` : ""}。`,
  };
}

function inventoryItems(home) {
  const graph = getHcmControlGraph(home);
  const logicalAssets = graph.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    roomId: asset.spaceId,
    type: asset.type,
    source: "logical_asset",
  }));
  const physicalThings = (home.things ?? [])
    .filter((thing) => thing.type !== "switch_panel")
    .map((thing) => ({ id: thing.id, name: thing.name, roomId: thing.spaceId, type: thing.type, source: "thing" }));
  return dedupeById([...logicalAssets, ...physicalThings]);
}

function findCapabilityQueryTargets(input, home) {
  const text = normalize(input);
  const candidates = inventoryItems(home)
    .filter((item) => item.source === "thing")
    .map((item) => home.things.find((thing) => thing.id === item.id))
    .filter(Boolean);
  const exact = candidates.filter((thing) => nameMatchesInput(thing, text, "exact"));
  if (exact.length > 0) return exact;
  return candidates.filter((thing) => nameMatchesInput(thing, text, "loose"));
}

function nameMatchesInput(thing, input, mode) {
  const names = [thing.name, thing.type, ...(thing.aliases ?? [])].map(normalize).filter(Boolean);
  if (mode === "exact") return names.some((name) => input.includes(name));
  return names.some((name) => name.length >= 2 && (input.includes(name) || name.includes(input)));
}

function summarizeThingCapabilities(thing) {
  const executable = [];
  const confirmable = [];
  const readable = [];
  const unsupported = [];
  const items = [];

  for (const capability of thing.capabilities ?? []) {
    const label = shortCapabilityName(capability.name);
    const item = {
      id: capability.id,
      name: capability.name,
      kind: capability.kind,
      domain: capability.binding?.domain,
      state: capability.state,
      autoExecutable: Boolean(capability.policy?.autoExecutable),
      risk: capability.policy?.risk,
      confirmation: capability.policy?.confirmation,
    };
    items.push(item);
    if (capability.binding?.domain === "notify" && /出粮|喂食|投喂/.test(capability.name)) {
      unsupported.push(`${label}（HA 暴露为通知域）`);
      continue;
    }
    if (capability.kind === "sensor") {
      if (isUsefulReadableCapability(capability)) readable.push(formatReadableCapability(capability, label));
      continue;
    }
    if ((capability.kind === "control" || capability.kind === "action") && capability.policy?.autoExecutable) {
      executable.push(label);
      continue;
    }
    if (capability.kind === "control" || capability.kind === "action" || capability.kind === "config") {
      confirmable.push(label);
    }
  }

  return {
    total: items.length,
    executable: dedupeText(executable).slice(0, 6),
    confirmable: dedupeText(confirmable).slice(0, 6),
    readable: dedupeText(readable).slice(0, 5),
    unsupported: dedupeText(unsupported).slice(0, 4),
    items,
  };
}

function isUsefulReadableCapability(capability) {
  const domain = capability.binding?.domain;
  if (domain === "event" || domain === "binary_sensor") return false;
  if (capability.state === undefined || capability.state === "unknown" || capability.state === "null") return false;
  return /剩余|状态|克数|进度|电量|温度|湿度|故障|异常|卡粮|出粮|食盆|进食|耗材|干燥剂/.test(capability.name);
}

function formatReadableCapability(capability, label) {
  if (capability.state === undefined || capability.state === "unknown") return label;
  return `${label}=${capability.state}`;
}

function shortCapabilityName(name = "") {
  return String(name)
    .replace(/^宠物喂食器\s*/, "")
    .replace(/^喂食器自定义spec\s*/, "")
    .replace(/^干燥剂\s*/, "")
    .replace(/^物理控制锁（童锁）\s*/, "")
    .trim();
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}

function dedupeText(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function inferCategory(input) {
  if (/射灯/.test(input)) return { label: "射灯", namePattern: /射灯/ };
  if (/灯带/.test(input)) return { label: "灯带", namePattern: /灯带/ };
  if (/吊灯/.test(input)) return { label: "吊灯", namePattern: /吊灯/ };
  if (/灯|照明/.test(input)) return { label: "灯", type: "light" };
  if (/空调/.test(input)) return { label: "空调", type: "ac" };
  if (/风扇/.test(input)) return { label: "风扇", type: "fan" };
  if (/窗帘/.test(input)) return { label: "窗帘", type: "curtain" };
  if (/传感器/.test(input)) return { label: "传感器", typePattern: /sensor/ };
  return { label: "设备" };
}

function matchesCategory(item, category) {
  if (category.namePattern) return category.namePattern.test(item.name);
  if (category.typePattern) return category.typePattern.test(item.type);
  if (category.type) return item.type === category.type;
  return true;
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
