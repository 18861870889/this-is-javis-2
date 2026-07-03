/**
 * Batch Action Expander
 *
 * Expands a single batch action (e.g. "关主卧所有灯") into individual
 * per-device actions by querying the HCM Control Graph.
 *
 * This is a pure local operation — no LLM, no API calls.
 * Latency: < 1ms for typical homes (< 100 devices).
 *
 * Planner draft format for batch:
 *   {
 *     "actions": [
 *       {
 *         "target": "主卧",        ← room name
 *         "capability": "power",
 *         "value": false,
 *         "batch_room": true       ← triggers batch expansion
 *       }
 *     ]
 *   }
 *
 * After expansion:
 *   {
 *     "actions": [
 *       { "target": "主卧床尾射灯", "capability": "power", "value": false },
 *       { "target": "主卧主灯", "capability": "power", "value": false },
 *       ...
 *     ]
 *   }
 */

import { getHcmControlGraph } from "./hcmControlGraph.js";
import { findExplicitRoomIds } from "./hcmControlGraph.js";
import { ROOM_ALIASES, getRoomAliasMap } from "./roomAliases.js";

/**
 * Build a room alias map from ROOM_ALIASES for use in resolveRoomIds.
 * Returns: Map<roomId, string[]> including name + all aliases.
 */
function buildRoomAliasMap(home) {
  return getRoomAliasMap(home);
}

/**
 * Expand batch actions in a planner draft.
 * If no batch actions are present, returns the draft unchanged.
 *
 * @param {Object} draft - planner draft with possible batch actions
 * @param {Object} home - HCM home model
 * @param {string} input - original user input (for room name resolution)
 * @returns {Object} draft with batch actions expanded
 */
export function expandBatchActions(draft, home, input = "") {
  if (!draft?.actions?.length) return draft;

  const hasBatch = draft.actions.some((a) => a?.batch_room || a?.batchRoom);
  if (!hasBatch) return draft;

  const graph = getHcmControlGraph(home);
  const expandedActions = [];

  for (const action of draft.actions) {
    if (!action?.batch_room && !action?.batchRoom) {
      expandedActions.push(action);
      continue;
    }

    // Resolve room name → spaceId
    const roomName = action.target || action.room || "";
    const roomIds = resolveRoomIds(roomName, input, home);

    if (roomIds.length === 0) {
      // Can't resolve room — pass through as-is, let safety gate handle it
      expandedActions.push(action);
      continue;
    }

    // Find all executable assets in the target room(s)
    // mappingStatus: "confirmed" (overlay-confirmed) or "inferred" (auto-detected)
    const roomAssets = graph.assets.filter(
      (asset) =>
        roomIds.includes(asset.spaceId) &&
        (asset.mappingStatus === "inferred" || asset.mappingStatus === "confirmed") &&
        asset.primaryEndpointId,
    );

    if (roomAssets.length === 0) {
      // No assets found — pass through as-is
      expandedActions.push(action);
      continue;
    }

    // Generate one action per asset
    for (const asset of roomAssets) {
      expandedActions.push({
        ...action,
        target: asset.name,
        device_id: asset.id,
        room_id: asset.spaceId,
        batch_room: undefined,
        batchRoom: undefined,
      });
    }
  }

  return {
    ...draft,
    actions: expandedActions,
    _batch_expanded: true,
    _batch_original_count: draft.actions.length,
    _batch_expanded_count: expandedActions.length,
  };
}

/**
 * Resolve a room name to spaceId(s).
 * Tries: direct name match → aliases → input text room patterns.
 */
function resolveRoomIds(roomName, input, home) {
  const normalized = roomName.trim();
  const aliasMap = buildRoomAliasMap(home);

  // 1a. Exact match (highest priority)
  const exact = [];
  for (const [roomId, labels] of aliasMap) {
    if (labels.some((label) => label === normalized)) exact.push(roomId);
  }
  if (exact.length > 0) return Array.from(new Set(exact));

  // 1b. Label contains query (e.g. "主卧卫生间" contains "主卧卫生")
  const labelContains = [];
  for (const [roomId, labels] of aliasMap) {
    if (labels.some((label) => label.includes(normalized))) labelContains.push(roomId);
  }
  if (labelContains.length > 0) return Array.from(new Set(labelContains));

  // 1c. Query contains label — pick the LONGEST matching label (most specific)
  const queryContains = [];
  for (const [roomId, labels] of aliasMap) {
    const matchLabel = labels.find((label) => normalized.includes(label));
    if (matchLabel) queryContains.push({ id: roomId, matchLen: matchLabel.length });
  }
  if (queryContains.length > 0) {
    queryContains.sort((a, b) => b.matchLen - a.matchLen);
    const maxLen = queryContains[0].matchLen;
    const best = queryContains.filter((x) => x.matchLen === maxLen).map((x) => x.id);
    return Array.from(new Set(best));
  }

  // 2. Use findExplicitRoomIds on the room name + input
  const fromInput = findExplicitRoomIds(`${roomName} ${input}`, home);
  if (fromInput.length > 0) return fromInput;

  return [];
}
