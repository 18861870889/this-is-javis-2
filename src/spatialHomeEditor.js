export const SPATIAL_EDITOR_VERSION = "0.22";

const MIN_ROOM_RECT_SIZE = 4;

export const SPATIAL_DEVICE_STATUS = {
  ASSIGNED_PLACED: "assigned_placed",
  ASSIGNED_UNPLACED: "assigned_unplaced",
  PLACED_UNASSIGNED: "placed_unassigned",
  UNORGANIZED: "unorganized",
};

export const NAMING_MODES = {
  ROOM_CUSTOM: "room_custom",
  ROOM_DEFAULT: "room_default",
};

export const SPATIAL_SUGGESTION_TYPES = {
  PLACE_ASSIGNED_DEVICE: "place_assigned_device",
  ASSIGN_PLACED_DEVICE: "assign_placed_device",
  REVIEW_ROOM_MISMATCH: "review_room_mismatch",
};

export function createSpatialEditorState(base = {}) {
  return {
    version: SPATIAL_EDITOR_VERSION,
    floorPlanImage: typeof base.floorPlanImage === "string" ? base.floorPlanImage : null,
    floorPlanImageName: typeof base.floorPlanImageName === "string" ? base.floorPlanImageName : "",
    floorPlanImageSize: Number.isFinite(Number(base.floorPlanImageSize)) ? Number(base.floorPlanImageSize) : 0,
    floorPlanImageAspectRatio: normalizeAspectRatio(base.floorPlanImageAspectRatio),
    floorPlanCoordinateMode: base.floorPlanCoordinateMode === "image" ? "image" : "container",
    floorPlanImageUpdatedAt: typeof base.floorPlanImageUpdatedAt === "string" ? base.floorPlanImageUpdatedAt : "",
    roomNames: normalizeRecord(base.roomNames),
    roomRects: normalizeRectRecord(base.roomRects),
    roomPolygons: normalizePolygonRecord(base.roomPolygons),
    roomGroups: normalizeRoomGroups(base.roomGroups),
    customRooms: normalizeCustomRooms(base.customRooms),
    deviceAssignments: normalizeRecord(base.deviceAssignments),
    devicePlacements: normalizePlacementRecord(base.devicePlacements),
    customDeviceNames: normalizeRecord(base.customDeviceNames),
    dismissedSuggestionIds: normalizeStringArray(base.dismissedSuggestionIds),
    namingMode: Object.values(NAMING_MODES).includes(base.namingMode) ? base.namingMode : NAMING_MODES.ROOM_DEFAULT,
  };
}

export function hasSpatialEditorEdits(state = {}) {
  const editorState = createSpatialEditorState(state);
  return Boolean(
    editorState.floorPlanImage ||
      editorState.floorPlanImageName ||
      editorState.floorPlanImageSize > 0 ||
      Object.keys(editorState.roomNames).length > 0 ||
      Object.keys(editorState.roomRects).length > 0 ||
      Object.keys(editorState.roomPolygons).length > 0 ||
      Object.keys(editorState.roomGroups).length > 0 ||
      editorState.customRooms.length > 0 ||
      Object.keys(editorState.deviceAssignments).length > 0 ||
      Object.keys(editorState.devicePlacements).length > 0 ||
      Object.keys(editorState.customDeviceNames).length > 0 ||
      editorState.dismissedSuggestionIds.length > 0 ||
      editorState.namingMode !== NAMING_MODES.ROOM_DEFAULT
  );
}

export function createSpatialEditorModel({ hcmHome, sceneModel, state } = {}) {
  const editorState = createSpatialEditorState(state);
  const rooms = normalizeEditorRooms(sceneModel?.rooms ?? [], editorState);
  const devices = normalizeEditorDevices({ hcmHome, sceneModel, rooms, state: editorState });
  const groups = groupSpatialDevices(devices);
  const suggestions = createSpatialSuggestions({ rooms, devices, state: editorState });
  return {
    version: SPATIAL_EDITOR_VERSION,
    rooms,
    devices,
    groups,
    suggestions,
    stats: Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.length])),
  };
}

export function groupSpatialDevices(devices = []) {
  const groups = {
    [SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED]: [],
    [SPATIAL_DEVICE_STATUS.ASSIGNED_UNPLACED]: [],
    [SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED]: [],
    [SPATIAL_DEVICE_STATUS.UNORGANIZED]: [],
  };
  for (const device of devices) {
    groups[device.spatialStatus]?.push(device);
  }
  return groups;
}

export function classifySpatialDevice({ assignedRoomId, placement } = {}) {
  const assigned = Boolean(assignedRoomId && assignedRoomId !== "unknown");
  const placed = Boolean(placement?.placed);
  if (assigned && placed) return SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED;
  if (assigned) return SPATIAL_DEVICE_STATUS.ASSIGNED_UNPLACED;
  if (placed) return SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED;
  return SPATIAL_DEVICE_STATUS.UNORGANIZED;
}

export function placeSpatialDevice(state, deviceId, { x, y, roomId = null } = {}) {
  const next = createSpatialEditorState(state);
  if (!deviceId) return next;
  next.devicePlacements[deviceId] = {
    placed: true,
    x: clampPercent(x),
    y: clampPercent(y),
    roomId: roomId || null,
  };
  // Only update room assignment when a room is detected at the placement position.
  // When roomId is null (device placed outside any room rect), preserve the existing
  // assignment so the device retains its defaultRoomId fallback instead of being
  // explicitly cleared to null (which causes "placed but unassigned" status).
  if (roomId) {
    next.deviceAssignments[deviceId] = roomId;
  }
  return next;
}

export function migrateSpatialEditorStateToImageCoordinates(
  state,
  { containerWidth, containerHeight, imageAspectRatio } = {},
) {
  const next = createSpatialEditorState(state);
  const frame = calculateContainedImageFrame({ containerWidth, containerHeight, imageAspectRatio });
  if (!frame) return {
    ...next,
    floorPlanImageAspectRatio: normalizeAspectRatio(imageAspectRatio),
    floorPlanCoordinateMode: "image",
  };
  next.floorPlanImageAspectRatio = normalizeAspectRatio(imageAspectRatio);
  next.floorPlanCoordinateMode = "image";
  next.roomRects = Object.fromEntries(
    Object.entries(next.roomRects).map(([roomId, rect]) => [roomId, convertRectFromContainerToImage(rect, frame)]),
  );
  next.roomPolygons = Object.fromEntries(
    Object.entries(next.roomPolygons).map(([roomId, points]) => [
      roomId,
      points.map((p) => convertPlacementFromContainerToImage(p, frame)),
    ]),
  );
  next.customRooms = next.customRooms.map((room) => ({
    ...room,
    mapRect: convertRectFromContainerToImage(room.mapRect, frame),
  }));
  next.devicePlacements = Object.fromEntries(
    Object.entries(next.devicePlacements).map(([deviceId, placement]) => [
      deviceId,
      convertPlacementFromContainerToImage(placement, frame),
    ]),
  );
  return next;
}

export function addSpatialRoom(state, room = {}) {
  const next = createSpatialEditorState(state);
  const id = uniqueSpatialRoomId(room.id, next);
  const name = String(room.name ?? "").trim() || "新房间";
  const mapRect = normalizeEditorRect(room.mapRect ?? room.rect ?? defaultCustomRoomRect(next.customRooms.length));
  next.customRooms = [...next.customRooms, { id, name, type: room.type || "generic", mapRect }];
  next.roomNames[id] = name;
  next.roomRects[id] = mapRect;
  return next;
}

export function removeSpatialRoom(state, roomId) {
  const next = createSpatialEditorState(state);
  if (!roomId || !next.customRooms.some((room) => room.id === roomId)) return next;
  next.customRooms = next.customRooms.filter((room) => room.id !== roomId);
  delete next.roomNames[roomId];
  delete next.roomRects[roomId];
  delete next.roomPolygons[roomId];
  for (const [deviceId, assignedRoomId] of Object.entries(next.deviceAssignments)) {
    if (assignedRoomId === roomId) next.deviceAssignments[deviceId] = null;
  }
  for (const [deviceId, placement] of Object.entries(next.devicePlacements)) {
    if (placement.roomId === roomId) next.devicePlacements[deviceId] = { ...placement, roomId: null };
  }
  return next;
}

export function mergeSpatialRooms(state, primaryRoomId, secondaryRoomIds = []) {
  const next = createSpatialEditorState(state);
  if (!primaryRoomId || secondaryRoomIds.length === 0) return next;
  const existingGroups = { ...next.roomGroups };
  const allSecondary = [...(existingGroups[primaryRoomId] ?? []), ...secondaryRoomIds];
  for (const secId of secondaryRoomIds) {
    if (secId === primaryRoomId) continue;
    if (existingGroups[secId]) {
      allSecondary.push(...existingGroups[secId]);
      delete existingGroups[secId];
    }
  }
  existingGroups[primaryRoomId] = Array.from(new Set(allSecondary.filter((id) => id !== primaryRoomId)));
  next.roomGroups = existingGroups;
  for (const secId of existingGroups[primaryRoomId]) {
    for (const [deviceId, assignedRoomId] of Object.entries(next.deviceAssignments)) {
      if (assignedRoomId === secId) next.deviceAssignments[deviceId] = primaryRoomId;
    }
    for (const [deviceId, placement] of Object.entries(next.devicePlacements)) {
      if (placement.roomId === secId) next.devicePlacements[deviceId] = { ...placement, roomId: primaryRoomId };
    }
  }
  return next;
}

export function splitSpatialRoom(state, roomId) {
  const next = createSpatialEditorState(state);
  if (!roomId || !next.roomGroups?.[roomId]) return next;
  const secondaryIds = next.roomGroups[roomId];
  delete next.roomGroups[roomId];
  for (const secId of secondaryIds) {
    const secRoom = next.customRooms.find((r) => r.id === secId);
    if (secRoom) {
      if (!next.roomNames[secId]) next.roomNames[secId] = secRoom.name;
      if (!next.roomRects[secId]) next.roomRects[secId] = secRoom.mapRect;
    }
  }
  return next;
}

export function updateSpatialRoomRect(state, roomId, rect) {
  const next = createSpatialEditorState(state);
  if (!roomId) return next;
  next.roomRects[roomId] = normalizeEditorRect(rect);
  next.customRooms = next.customRooms.map((room) =>
    room.id === roomId ? { ...room, mapRect: next.roomRects[roomId] } : room
  );
  return next;
}

export function updateSpatialRoomRects(state, updates) {
  let next = createSpatialEditorState(state);
  for (const { roomId, rect } of updates) {
    if (!roomId) continue;
    next.roomRects[roomId] = normalizeEditorRect(rect);
    next.customRooms = next.customRooms.map((room) =>
      room.id === roomId ? { ...room, mapRect: next.roomRects[roomId] } : room
    );
  }
  return next;
}

export function assignSpatialDevice(state, deviceId, roomId) {
  const next = createSpatialEditorState(state);
  if (!deviceId) return next;
  next.deviceAssignments[deviceId] = roomId || null;
  const placement = next.devicePlacements[deviceId];
  if (placement?.placed) {
    next.devicePlacements[deviceId] = { ...placement, roomId: roomId || null };
  }
  return next;
}

export function clearSpatialPlacement(state, deviceId) {
  const next = createSpatialEditorState(state);
  delete next.devicePlacements[deviceId];
  return next;
}

export function updateSpatialRoomName(state, roomId, name) {
  const next = createSpatialEditorState(state);
  if (!roomId) return next;
  const value = String(name ?? "").trim();
  if (value) next.roomNames[roomId] = value;
  else delete next.roomNames[roomId];
  next.customRooms = next.customRooms.map((room) => (room.id === roomId ? { ...room, name: value || room.name } : room));
  return next;
}

export function updateSpatialDeviceName(state, deviceId, name) {
  const next = createSpatialEditorState(state);
  if (!deviceId) return next;
  const value = String(name ?? "").trim();
  if (value) next.customDeviceNames[deviceId] = value;
  else delete next.customDeviceNames[deviceId];
  return next;
}

export function dismissSpatialSuggestion(state, suggestionId) {
  const next = createSpatialEditorState(state);
  if (!suggestionId) return next;
  next.dismissedSuggestionIds = Array.from(new Set([...next.dismissedSuggestionIds, suggestionId]));
  return next;
}

export function applySpatialSuggestion(state, suggestion) {
  const next = createSpatialEditorState(state);
  if (!suggestion?.deviceId) return next;
  const roomId = suggestion.roomId || suggestion.patch?.assignmentRoomId || null;
  if (suggestion.patch?.placement) {
    return placeSpatialDevice(next, suggestion.deviceId, {
      x: suggestion.patch.placement.x,
      y: suggestion.patch.placement.y,
      roomId,
    });
  }
  if (roomId) return assignSpatialDevice(next, suggestion.deviceId, roomId);
  return next;
}

export function composeSpatialDeviceName(device, roomName, state) {
  const editorState = createSpatialEditorState(state);
  const baseName =
    editorState.namingMode === NAMING_MODES.ROOM_CUSTOM
      ? editorState.customDeviceNames[device.id] || stripRoomPrefix(device.name, roomName)
      : stripRoomPrefix(device.name, roomName);
  return roomName ? roomName + baseName : baseName;
}

export function applySpatialEditorToScene(sceneModel, spatialModel) {
  if (!sceneModel || !spatialModel) return sceneModel;
  const roomById = new globalThis.Map(spatialModel.rooms.map((room) => [room.id, room]));
  const deviceById = new globalThis.Map(spatialModel.devices.map((device) => [device.id, device]));
  const bounds = calculateSceneBounds(sceneModel.rooms ?? []);
  const projectedDevices = (sceneModel.devices ?? []).map((device) => {
    const spatialDevice = deviceById.get(device.id);
    if (!spatialDevice) return device;
    const placement = spatialDevice.placement;
    const [sceneX, sceneZ] = placement?.placed
      ? editorPointToScenePoint(placement, bounds)
      : [device.sceneX, device.sceneZ];
    const assignedRoomId = roomById.has(spatialDevice.assignedRoomId) ? spatialDevice.assignedRoomId : device.roomId;
    return {
      ...device,
      name: spatialDevice.displayName || device.name,
      roomId: assignedRoomId,
      sceneX,
      sceneZ,
      spatialStatus: spatialDevice.spatialStatus,
      spatialPlacement: placement,
      spatialSource: placement?.placed || assignedRoomId !== device.roomId ? "editor" : device.spatialSource,
    };
  });
  const deviceCounts = countProjectedDevices(projectedDevices);
  const projectedRooms = (spatialModel.rooms ?? []).map((spatialRoom) => {
    const originalRoom = (sceneModel.rooms ?? []).find((room) => room.id === spatialRoom.id);
    return {
      ...originalRoom,
      ...spatialRoom,
      name: spatialRoom.editorName ?? spatialRoom.name,
      deviceCount: deviceCounts.get(spatialRoom.id) ?? 0,
      spatialSource:
        spatialRoom.spatialSource === "editor" || spatialRoom.editorName !== originalRoom?.name
          ? "editor"
          : originalRoom?.spatialSource,
    };
  });
  return {
    ...sceneModel,
    rooms: projectedRooms,
    devices: projectedDevices,
    spatialProjection: {
      version: spatialModel.version,
      applied: true,
      placedDeviceCount: projectedDevices.filter((device) => device.spatialPlacement?.placed).length,
    },
  };
}

export function mapSceneRoomToEditorRect(room, bounds) {
  if (!room || !bounds) return null;
  const left = ((room.x - room.width / 2 - bounds.minX) / bounds.width) * 100;
  const top = ((room.z - room.depth / 2 - bounds.minZ) / bounds.depth) * 100;
  return {
    left: clampPercent(left),
    top: clampPercent(top),
    width: clampPercent((room.width / bounds.width) * 100),
    height: clampPercent((room.depth / bounds.depth) * 100),
    centerX: clampPercent(((room.x - bounds.minX) / bounds.width) * 100),
    centerY: clampPercent(((room.z - bounds.minZ) / bounds.depth) * 100),
  };
}

export function findSpatialRoomAtPoint(rooms = [], x, y) {
  const px = clampPercent(x);
  const py = clampPercent(y);
  const polygonRoom = [...rooms]
    .reverse()
    .find((room) => {
      if (!room.polygon || room.polygon.length < 3) return false;
      return pointInPolygon(room.polygon, px, py);
    });
  if (polygonRoom) return polygonRoom;
  return [...rooms]
    .reverse()
    .find((room) => {
      const rect = room.mapRect;
      return (
        rect &&
        px >= rect.left &&
        px <= rect.left + rect.width &&
        py >= rect.top &&
        py <= rect.top + rect.height
      );
    }) ?? null;
}

export function pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(points) {
  if (!points?.length) return { x: 50, y: 50 };
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  return { x: cx / points.length, y: cy / points.length };
}

export function polygonToBounds(points) {
  if (!points?.length) return normalizeEditorRect({ left: 35, top: 35, width: 20, height: 20 });
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return normalizeEditorRect({ left: minX, top: minY, width: maxX - minX, height: maxY - minY });
}

export function addSpatialPolygonRoom(state, room = {}) {
  const next = createSpatialEditorState(state);
  const id = uniqueSpatialRoomId(room.id, next);
  const name = String(room.name ?? "").trim() || "新房间";
  const points = Array.isArray(room.points) && room.points.length >= 3
    ? room.points.map(p => ({ x: clampPercent(p.x), y: clampPercent(p.y) }))
    : defaultPolygonPoints();
  next.customRooms = [...next.customRooms, { id, name, type: room.type || "generic", mapRect: polygonToBounds(points) }];
  next.roomNames[id] = name;
  next.roomPolygons[id] = points;
  return next;
}

export function updateSpatialRoomPolygon(state, roomId, points) {
  const next = createSpatialEditorState(state);
  if (!roomId || !Array.isArray(points) || points.length < 3) return next;
  next.roomPolygons[roomId] = points.map(p => ({ x: clampPercent(p.x), y: clampPercent(p.y) }));
  next.customRooms = next.customRooms.map((room) =>
    room.id === roomId ? { ...room, mapRect: polygonToBounds(next.roomPolygons[roomId]) } : room
  );
  next.roomRects[roomId] = next.customRooms.find(r => r.id === roomId)?.mapRect ?? next.roomRects[roomId];
  return next;
}

export function removeSpatialPolygon(state, roomId) {
  const next = createSpatialEditorState(state);
  if (!roomId) return next;
  delete next.roomPolygons[roomId];
  return next;
}

function normalizeEditorRooms(sceneRooms, state) {
  const bounds = calculateSceneBounds(sceneRooms);
  const baseRooms = sceneRooms.map((room) => {
    const overrideRect = state.roomRects[room.id];
    const polygon = state.roomPolygons[room.id];
    const mapRect = overrideRect ?? mapSceneRoomToEditorRect(room, bounds);
    const geometry = overrideRect ? editorRectToSceneRoom(mapRect, bounds) : {};
    const polygonScenePoints = polygon ? editorPolygonToScenePoints(polygon, bounds) : null;
    return {
      ...room,
      ...geometry,
      editorName: state.roomNames[room.id] || room.name,
      mapRect,
      polygon: polygon ?? null,
      polygonScenePoints,
      custom: false,
      spatialSource: overrideRect || polygon ? "editor" : room.spatialSource,
    };
  });
  const customRooms = state.customRooms.map((room) => {
    const mapRect = state.roomRects[room.id] ?? room.mapRect;
    const polygon = state.roomPolygons[room.id];
    const polygonScenePoints = polygon ? editorPolygonToScenePoints(polygon, bounds) : null;
    return {
      ...editorRectToSceneRoom(mapRect, bounds),
      id: room.id,
      name: room.name,
      type: room.type || "generic",
      editorName: state.roomNames[room.id] || room.name,
      mapRect,
      polygon: polygon ?? null,
      polygonScenePoints,
      custom: true,
      spatialSource: "editor",
      deviceCount: 0,
    };
  });
  const allRooms = [...baseRooms, ...customRooms];

  // Apply room groups: hide secondary rooms, add allRects to primary rooms
  const secondaryIds = new Set(Object.values(state.roomGroups ?? {}).flat());
  const visibleRooms = allRooms.filter((room) => !secondaryIds.has(room.id));
  const roomById = new globalThis.Map(allRooms.map((room) => [room.id, room]));
  return visibleRooms.map((room) => {
    const groupSecondary = state.roomGroups?.[room.id];
    if (!groupSecondary?.length) return room;
    const secondaryRooms = groupSecondary
      .map((id) => roomById.get(id))
      .filter(Boolean);
    const secondaryRects = secondaryRooms
      .map((sec) => editorRectToSceneRoom(sec.mapRect, bounds));
    const secondaryMapRects = secondaryRooms
      .map((sec) => sec.mapRect)
      .filter(Boolean);
    return {
      ...room,
      allRects: [editorRectToSceneRoom(room.mapRect, bounds), ...secondaryRects],
      allMapRects: [room.mapRect, ...secondaryMapRects].filter(Boolean),
      mergedCount: groupSecondary.length + 1,
    };
  });
}

function editorPolygonToScenePoints(polygon, bounds) {
  return polygon.map((p) => ({
    x: roundPoint(bounds.minX + (clampPercent(p.x) / 100) * bounds.width),
    z: roundPoint(bounds.minZ + (clampPercent(p.y) / 100) * bounds.depth),
  }));
}

function createSpatialSuggestions({ rooms, devices, state }) {
  const roomById = new globalThis.Map(rooms.map((room) => [room.id, room]));
  const dismissed = new Set(state.dismissedSuggestionIds ?? []);
  return devices
    .flatMap((device) => {
      const suggestions = [];
      const assignedRoom = device.assignedRoomId ? roomById.get(device.assignedRoomId) : null;
      const placementRoom = device.placement?.roomId ? roomById.get(device.placement.roomId) : null;
      if (assignedRoom?.mapRect && !device.placement?.placed) {
        suggestions.push(createPlaceSuggestion(device, assignedRoom));
      }
      if (!device.assignedRoomId && placementRoom) {
        suggestions.push(createAssignSuggestion(device, placementRoom));
      }
      if (
        device.assignedRoomId &&
        device.placement?.placed &&
        device.placement.roomId &&
        device.placement.roomId !== device.assignedRoomId &&
        placementRoom
      ) {
        suggestions.push(createRoomMismatchSuggestion(device, placementRoom));
      }
      return suggestions;
    })
    .filter((suggestion) => !dismissed.has(suggestion.id))
    .filter((suggestion, index, array) =>
      // Dedup: keep only first suggestion per unique title+roomName combination
      index === array.findIndex((s) => s.title === suggestion.title && s.roomName === suggestion.roomName)
    )
    .sort(compareSpatialSuggestions);
}

function createPlaceSuggestion(device, room) {
  return {
    id: `place:${device.id}:${room.id}`,
    type: SPATIAL_SUGGESTION_TYPES.PLACE_ASSIGNED_DEVICE,
    deviceId: device.id,
    deviceName: device.displayName,
    roomId: room.id,
    roomName: room.editorName,
    title: `定位到${room.editorName}`,
    reason: device.role === "physical_controller"
      ? "根据控制器安装房间生成维护定位建议"
      : "根据 HCM 语义房间生成生活视图定位建议",
    confidence: device.role === "logical_asset" ? 0.84 : 0.68,
    patch: {
      assignmentRoomId: room.id,
      placement: { x: room.mapRect.centerX, y: room.mapRect.centerY },
    },
  };
}

function createAssignSuggestion(device, room) {
  return {
    id: `assign:${device.id}:${room.id}`,
    type: SPATIAL_SUGGESTION_TYPES.ASSIGN_PLACED_DEVICE,
    deviceId: device.id,
    deviceName: device.displayName,
    roomId: room.id,
    roomName: room.editorName,
    title: `归入${room.editorName}`,
    reason: "设备已经放在该房间区域内，建议同步房间归属",
    confidence: 0.78,
    patch: { assignmentRoomId: room.id },
  };
}

function createRoomMismatchSuggestion(device, room) {
  return {
    id: `mismatch:${device.id}:${device.assignedRoomId}:${room.id}`,
    type: SPATIAL_SUGGESTION_TYPES.REVIEW_ROOM_MISMATCH,
    deviceId: device.id,
    deviceName: device.displayName,
    roomId: room.id,
    roomName: room.editorName,
    title: `检查${room.editorName}归属`,
    reason: "地图位置和房间归属不一致，建议以当前放置房间为准",
    confidence: 0.58,
    patch: { assignmentRoomId: room.id },
  };
}

function compareSpatialSuggestions(first, second) {
  return second.confidence - first.confidence || first.deviceName.localeCompare(second.deviceName, "zh-CN");
}

function normalizeEditorDevices({ hcmHome, sceneModel, rooms, state }) {
  const roomById = new globalThis.Map(rooms.map((room) => [room.id, room]));
  const baseDevices = new globalThis.Map();

  for (const device of sceneModel?.devices ?? []) {
    baseDevices.set(device.id, {
      id: device.id,
      name: device.name,
      type: device.type,
      role: device.logicalAsset ? "logical_asset" : "device",
      source: device.source ?? sceneModel?.source ?? "scene",
      defaultRoomId: device.roomId,
      providerThingId: device.providerThingId,
      online: device.online,
      statusLabel: device.statusLabel,
      risk: device.risk,
    });
  }

  for (const controller of hcmHome?.controlGraph?.controllers ?? []) {
    const id = controller.providerThingId || controller.id;
    if (baseDevices.has(id)) continue;
    baseDevices.set(id, {
      id,
      name: controller.name,
      type: "switch_panel",
      role: "physical_controller",
      source: "hcm-control-graph",
      defaultRoomId: controller.installedSpaceId,
      online: controller.online,
      statusLabel: `${controller.endpointIds?.length ?? 0} 通道`,
      risk: "low",
    });
  }

  return Array.from(baseDevices.values())
    .map((device) => {
      const assignedRoomId = Object.prototype.hasOwnProperty.call(state.deviceAssignments, device.id)
        ? state.deviceAssignments[device.id]
        : device.defaultRoomId;
      const assignedRoom = assignedRoomId ? roomById.get(assignedRoomId) : null;
      let placement = state.devicePlacements[device.id] ?? null;
      // Auto-place: if device has an assigned room with a mapRect but no explicit placement,
      // generate a default placement at the room center
      if (!placement && assignedRoom?.mapRect) {
        placement = {
          placed: true,
          x: assignedRoom.mapRect.centerX,
          y: assignedRoom.mapRect.centerY,
          roomId: assignedRoomId,
          auto: true,  // mark as auto-placed so UI can distinguish
        };
      }
      return {
        ...device,
        assignedRoomId: assignedRoomId || null,
        assignedRoomName: assignedRoom?.editorName ?? null,
        placement,
        spatialStatus: classifySpatialDevice({ assignedRoomId, placement }),
        displayName: composeSpatialDeviceName(device, assignedRoom?.editorName, state),
      };
    })
    .sort(compareSpatialDevices);
}

function compareSpatialDevices(first, second) {
  const roleDelta = roleRank(first.role) - roleRank(second.role);
  if (roleDelta !== 0) return roleDelta;
  const statusDelta = statusRank(first.spatialStatus) - statusRank(second.spatialStatus);
  if (statusDelta !== 0) return statusDelta;
  return first.displayName.localeCompare(second.displayName, "zh-CN");
}

function roleRank(role) {
  if (role === "logical_asset") return 0;
  if (role === "device") return 1;
  if (role === "physical_controller") return 2;
  return 3;
}

function statusRank(status) {
  return [
    SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
    SPATIAL_DEVICE_STATUS.ASSIGNED_UNPLACED,
    SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED,
    SPATIAL_DEVICE_STATUS.UNORGANIZED,
  ].indexOf(status);
}

function calculateSceneBounds(rooms) {
  if (!rooms?.length) return { minX: 0, minZ: 0, width: 1, depth: 1 };
  const minX = Math.min(...rooms.map((room) => room.x - room.width / 2));
  const maxX = Math.max(...rooms.map((room) => room.x + room.width / 2));
  const minZ = Math.min(...rooms.map((room) => room.z - room.depth / 2));
  const maxZ = Math.max(...rooms.map((room) => room.z + room.depth / 2));
  return {
    minX,
    minZ,
    width: Math.max(0.1, maxX - minX),
    depth: Math.max(0.1, maxZ - minZ),
  };
}

function editorPointToScenePoint(placement, bounds) {
  return [
    roundPoint(bounds.minX + (clampPercent(placement.x) / 100) * bounds.width),
    roundPoint(bounds.minZ + (clampPercent(placement.y) / 100) * bounds.depth),
  ];
}

function countProjectedDevices(devices) {
  const counts = new globalThis.Map();
  for (const device of devices ?? []) {
    if (!device.roomId) continue;
    counts.set(device.roomId, (counts.get(device.roomId) ?? 0) + 1);
  }
  return counts;
}

function stripRoomPrefix(name, roomName) {
  if (!roomName) return name;
  const text = String(name ?? "");
  return text.startsWith(roomName) ? text.slice(roomName.length) || text : text;
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => key && (typeof entry === "string" || entry === null)));
}

function normalizeRectRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, rect]) => key && rect && typeof rect === "object")
      .map(([key, rect]) => [key, normalizeEditorRect(rect)]),
  );
}

function normalizePolygonRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, points] of Object.entries(value)) {
    if (!key || !Array.isArray(points) || points.length < 3) continue;
    const normalized = points
      .filter((p) => p && typeof p === "object" && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map((p) => ({ x: clampPercent(p.x), y: clampPercent(p.y) }));
    if (normalized.length >= 3) result[key] = normalized;
  }
  return result;
}

function defaultPolygonPoints() {
  return [
    { x: 40, y: 35 },
    { x: 60, y: 35 },
    { x: 60, y: 55 },
    { x: 40, y: 55 },
  ];
}

function normalizeRoomGroups(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!key || !Array.isArray(ids)) continue;
    const valid = ids.filter((id) => typeof id === "string" && id && id !== key);
    if (valid.length > 0) result[key] = valid;
  }
  return result;
}

function normalizeCustomRooms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((room) => room && typeof room === "object")
    .map((room, index) => {
      const id = String(room.id ?? "").trim() || `custom_room_${index + 1}`;
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name: String(room.name ?? "").trim() || "新房间",
        type: String(room.type ?? "").trim() || "generic",
        mapRect: normalizeEditorRect(room.mapRect ?? room.rect ?? defaultCustomRoomRect(index)),
      };
    })
    .filter(Boolean);
}

function normalizePlacementRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, placement]) => placement && typeof placement === "object")
      .map(([key, placement]) => [
        key,
        {
          placed: Boolean(placement.placed),
          x: clampPercent(placement.x),
          y: clampPercent(placement.y),
          roomId: placement.roomId || null,
        },
      ]),
  );
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeAspectRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(0.1, Math.min(10, Math.round(number * 10000) / 10000));
}

function calculateContainedImageFrame({ containerWidth, containerHeight, imageAspectRatio } = {}) {
  const width = Number(containerWidth);
  const height = Number(containerHeight);
  const aspectRatio = normalizeAspectRatio(imageAspectRatio);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || !aspectRatio) return null;
  const containerRatio = width / height;
  if (containerRatio > aspectRatio) {
    const imageHeight = height;
    const imageWidth = height * aspectRatio;
    return {
      imageWidth,
      imageHeight,
      offsetX: (width - imageWidth) / 2,
      offsetY: 0,
      containerWidth: width,
      containerHeight: height,
    };
  }
  const imageWidth = width;
  const imageHeight = width / aspectRatio;
  return {
    imageWidth,
    imageHeight,
    offsetX: 0,
    offsetY: (height - imageHeight) / 2,
    containerWidth: width,
    containerHeight: height,
  };
}

function convertRectFromContainerToImage(rect, frame) {
  const normalized = normalizeEditorRect(rect);
  return normalizeEditorRect({
    left: (((normalized.left / 100) * frame.containerWidth - frame.offsetX) / frame.imageWidth) * 100,
    top: (((normalized.top / 100) * frame.containerHeight - frame.offsetY) / frame.imageHeight) * 100,
    width: ((normalized.width / 100) * frame.containerWidth / frame.imageWidth) * 100,
    height: ((normalized.height / 100) * frame.containerHeight / frame.imageHeight) * 100,
  });
}

function convertPlacementFromContainerToImage(placement, frame) {
  return {
    ...placement,
    x: clampPercent((((clampPercent(placement.x) / 100) * frame.containerWidth - frame.offsetX) / frame.imageWidth) * 100),
    y: clampPercent((((clampPercent(placement.y) / 100) * frame.containerHeight - frame.offsetY) / frame.imageHeight) * 100),
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number * 100) / 100));
}

function normalizeEditorRect(rect = {}) {
  const width = clampRoomSize(rect.width ?? 16);
  const height = clampRoomSize(rect.height ?? 12);
  const left = clampRoomEdge(rect.left, width);
  const top = clampRoomEdge(rect.top, height);
  return {
    left,
    top,
    width,
    height,
    centerX: clampPercent(left + width / 2),
    centerY: clampPercent(top + height / 2),
  };
}

function clampRoomSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MIN_ROOM_RECT_SIZE;
  return Math.max(MIN_ROOM_RECT_SIZE, Math.min(100, Math.round(number * 100) / 100));
}

function clampRoomEdge(value, size) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100 - size, Math.round(number * 100) / 100));
}

function editorRectToSceneRoom(rect, bounds) {
  const normalized = normalizeEditorRect(rect);
  return {
    x: roundPoint(bounds.minX + ((normalized.left + normalized.width / 2) / 100) * bounds.width),
    z: roundPoint(bounds.minZ + ((normalized.top + normalized.height / 2) / 100) * bounds.depth),
    width: roundPoint(Math.max(0.35, (normalized.width / 100) * bounds.width)),
    depth: roundPoint(Math.max(0.35, (normalized.height / 100) * bounds.depth)),
  };
}

function defaultCustomRoomRect(index = 0) {
  const offset = (index % 5) * 3;
  return normalizeEditorRect({ left: 38 + offset, top: 34 + offset, width: 18, height: 14 });
}

function uniqueSpatialRoomId(seed, state) {
  const existingIds = new Set([
    ...Object.keys(state.roomNames ?? {}),
    ...Object.keys(state.roomRects ?? {}),
    ...(state.customRooms ?? []).map((room) => room.id),
  ]);
  const base = String(seed ?? "").trim() || `custom_room_${Date.now().toString(36)}`;
  if (!existingIds.has(base)) return base;
  let index = 2;
  while (existingIds.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function roundPoint(value) {
  return Math.round(value * 100) / 100;
}
