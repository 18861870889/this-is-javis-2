import { createSpatialEditorState } from "./spatialHomeEditor.js";

export const SPATIAL_SEMANTIC_OVERLAY_VERSION = "0.1";

export function applySpatialSemanticOverlay(home, spatialRecordOrState = null) {
  if (!home || typeof home !== "object") return home;
  const state = normalizeSpatialState(spatialRecordOrState);
  const roomIndex = buildSpatialRoomIndex(home, state);
  const assignmentEntries = Object.entries(state.deviceAssignments ?? {}).filter(([, roomId]) => roomId && roomIndex.has(roomId));
  const hasRoomNames = Object.keys(state.roomNames ?? {}).length > 0;
  if (!hasRoomNames && assignmentEntries.length === 0) return home;

  const assetAssignments = new Map();
  const thingAssignments = new Map();
  const assetById = new Map((home.controlGraph?.assets ?? []).map((asset) => [asset.id, asset]));

  for (const [deviceId, roomId] of assignmentEntries) {
    if (assetById.has(deviceId)) assetAssignments.set(deviceId, roomId);
    else thingAssignments.set(deviceId, roomId);
  }

  const spaces = mergeSpatialSpaces(home.spaces ?? [], roomIndex);
  const roomsById = new Map(spaces.map((space) => [space.id, space]));
  const things = (home.things ?? []).map((thing) => patchThingWithSpatialRoom(thing, thingAssignments.get(thing.id), roomsById));
  const controlGraph = home.controlGraph
    ? patchControlGraphWithSpatialRooms(home.controlGraph, assetAssignments, roomsById)
    : home.controlGraph;

  return {
    ...home,
    spaces,
    things,
    stats: {
      ...home.stats,
      spaceCount: spaces.length,
    },
    controlGraph,
    spatialSemantic: {
      version: SPATIAL_SEMANTIC_OVERLAY_VERSION,
      applied: true,
      source: spatialRecordOrState?.source ?? "spatial-editor",
      updatedAt: spatialRecordOrState?.updatedAt ?? null,
      roomCount: roomIndex.size,
      assignedAssetCount: assetAssignments.size,
      assignedThingCount: thingAssignments.size,
    },
  };
}

function normalizeSpatialState(spatialRecordOrState) {
  const value = spatialRecordOrState?.state && typeof spatialRecordOrState.state === "object"
    ? spatialRecordOrState.state
    : spatialRecordOrState;
  return createSpatialEditorState(value ?? {});
}

function buildSpatialRoomIndex(home, state) {
  const rooms = new Map();
  for (const space of home?.spaces ?? []) {
    const editorName = cleanName(state.roomNames?.[space.id]);
    rooms.set(space.id, {
      id: space.id,
      name: editorName || space.name || space.id,
      baseRoomId: space.id,
      baseName: space.name || space.id,
      aliases: mergeText([...(space.aliases ?? []), editorName, space.name]),
      custom: false,
      source: editorName && editorName !== space.name ? "map_editor" : "hcm",
    });
  }
  for (const room of state.customRooms ?? []) {
    const name = cleanName(state.roomNames?.[room.id]) || cleanName(room.name);
    if (!room.id || !name) continue;
    rooms.set(room.id, {
      id: room.id,
      name,
      baseRoomId: null,
      baseName: "",
      aliases: [name],
      custom: true,
      source: "map_editor",
    });
  }
  for (const [roomId, name] of Object.entries(state.roomNames ?? {})) {
    if (rooms.has(roomId) || !cleanName(name)) continue;
    rooms.set(roomId, {
      id: roomId,
      name: cleanName(name),
      baseRoomId: null,
      baseName: "",
      aliases: [cleanName(name)],
      custom: true,
      source: "map_editor",
    });
  }
  return rooms;
}

function mergeSpatialSpaces(spaces, roomIndex) {
  const next = spaces.map((space) => {
    const room = roomIndex.get(space.id);
    if (!room) {
      return {
        ...space,
        aliases: mergeText(space.aliases ?? []),
      };
    }
    return {
      ...space,
      name: room.name,
      aliases: mergeText([...(space.aliases ?? []), room.baseName, ...(room.aliases ?? [])]),
      spatialSemantic: {
        source: room.source,
        baseName: room.baseName || space.name,
      },
    };
  });

  const existing = new Set(next.map((space) => space.id));
  for (const room of roomIndex.values()) {
    if (!room.custom || existing.has(room.id)) continue;
    next.push({
      id: room.id,
      name: room.name,
      aliases: room.aliases ?? [room.name],
      provider: null,
      spatialSemantic: {
        source: "map_editor",
        custom: true,
      },
    });
  }
  return next;
}

function patchThingWithSpatialRoom(thing, assignedRoomId, roomsById) {
  const room = roomsById.get(assignedRoomId);
  if (!room) return thing;
  const displayName = composeSpatialName(thing.name, room.name, room.name, null);
  return {
    ...thing,
    name: displayName,
    spaceId: assignedRoomId,
    baseSpaceId: thing.baseSpaceId ?? thing.spaceId,
    aliases: mergeText([thing.name, ...(thing.aliases ?? []), displayName]),
    spatialRoomId: assignedRoomId,
    spatialRoomName: room.name,
    spatialSemantic: {
      source: "map_editor",
      roomId: assignedRoomId,
      roomName: room.name,
      baseRoomId: thing.spaceId,
    },
  };
}

function patchControlGraphWithSpatialRooms(controlGraph, assetAssignments, roomsById) {
  return {
    ...controlGraph,
    assets: (controlGraph.assets ?? []).map((asset) => {
      const assignedRoomId = assetAssignments.get(asset.id);
      const room = roomsById.get(assignedRoomId);
      if (!room) return asset;
      const displayName = composeSpatialName(asset.name, room.name, asset.roomName, null);
      return {
        ...asset,
        name: displayName,
        spaceId: assignedRoomId,
        roomName: room.name,
        baseSpaceId: asset.baseSpaceId ?? asset.spaceId,
        baseRoomName: asset.baseRoomName ?? asset.roomName,
        aliases: mergeText([
          asset.name,
          ...(asset.aliases ?? []),
          displayName,
          stripRoomPrefix(asset.name, room.name),
        ]),
        spatialRoomId: assignedRoomId,
        spatialRoomName: room.name,
        spatialSemantic: {
          source: "map_editor",
          roomId: assignedRoomId,
          roomName: room.name,
          baseRoomId: asset.spaceId,
          baseRoomName: asset.roomName,
        },
      };
    }),
  };
}

function composeSpatialName(name, roomName, previousRoomName, customName) {
  const baseName = cleanName(customName) || stripRoomPrefix(stripRoomPrefix(name, roomName), previousRoomName);
  if (!roomName) return baseName || name;
  return `${roomName}${baseName || name}`;
}

function stripRoomPrefix(name, roomName) {
  const text = String(name ?? "").trim();
  const prefix = cleanName(roomName);
  if (!prefix) return text;
  return text.startsWith(prefix) ? text.slice(prefix.length) || text : text;
}

function mergeText(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat()) {
    const text = cleanName(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function cleanName(value) {
  return typeof value === "string" ? value.trim() : "";
}
