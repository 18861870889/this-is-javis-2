/**
 * Room alias mapping — shared across all HCM modules.
 *
 * Used by:
 * - hcmControlGraph.js (findExplicitRoomIds)
 * - hcmStateQuery.js (room resolution for state queries)
 * - batchExpander.js (resolveRoomIds)
 *
 * roomId → [alias1, alias2, ...]
 */
export const ROOM_ALIASES = [
  ["entry", ["玄关", "入户", "门口", "门厅"]],
  ["living", ["客厅", "大厅", "沙发"]],
  ["dining", ["餐厅"]],
  ["kitchen", ["厨房"]],
  ["study", ["书房"]],
  ["master", ["主卧", "卧室", "主人房", "大卧室"]],
  ["second", ["次卧", "小孩房", "儿童房", "二卧"]],
  ["cat_room", ["猫猫房", "猫房", "小孩房"]],
  ["bath", ["公共卫生间", "公卫", "浴室", "洗手台", "公共厕所", "客卫"]],
  ["master_bath", ["主卧卫生间", "主卫", "主卧厕所", "主卧洗手间", "主人房厕所", "主卧浴室"]],
  ["balcony", ["阳台"]],
];

const SPECIFIC_ROOM_REFERENCE_RE =
  /主卧卫生间|主卧洗手间|主卧厕所|主卧浴室|主人房厕所|公共卫生间|公共厕所|玄关|入户|门口|门厅|客厅|大厅|沙发|餐厅|厨房|书房|主卧|主人房|大卧室|次卧|二卧|小孩房|儿童房|猫猫房|猫房|公卫|客卫|主卫|阳台/;

export function hasSpecificRoomReference(input) {
  const text = String(input ?? "").trim().replace(/\s+/g, "");
  return SPECIFIC_ROOM_REFERENCE_RE.test(text);
}

/**
 * Get all labels (name + aliases) for a room ID.
 */
export function getRoomLabels(roomId, home) {
  const space = home?.spaces?.find((s) => s.id === roomId);
  const fromSpace = space ? [space.name, space.id, ...(space.aliases ?? [])].filter(Boolean) : [];
  const fromAlias = ROOM_ALIASES.find(([id]) => id === roomId)?.[1] ?? [];
  return [...fromSpace, ...fromAlias];
}

/**
 * Get a map of roomId → [labels] for all rooms.
 */
export function getRoomAliasMap(home) {
  const map = new Map();
  for (const space of home?.spaces ?? []) {
    map.set(space.id, [space.name, ...(space.aliases ?? [])].filter(Boolean));
  }
  for (const [roomId, aliases] of ROOM_ALIASES) {
    const existing = map.get(roomId) ?? [];
    map.set(roomId, [...existing, ...aliases]);
  }
  return map;
}
