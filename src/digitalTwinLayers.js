const LAYER_ORDER = ["occupancy", "selection", "preview", "execution", "alert"];

export function buildDigitalTwinLayers({
  sceneModel,
  selectedRoomId,
  context,
  plan,
  diagnostics,
} = {}) {
  const rooms = sceneModel?.rooms ?? [];
  const devices = sceneModel?.devices ?? [];
  const roomIds = new Set(rooms.map((room) => room.id));
  const deviceIds = new Set(devices.map((device) => device.id));
  const layers = {
    selection: selectedRoomId && roomIds.has(selectedRoomId) ? { roomIds: [selectedRoomId], deviceIds: [] } : emptyLayer(),
    occupancy: {
      roomIds: occupiedRoomIds(context, roomIds),
      deviceIds: [],
    },
    execution: {
      roomIds: targetRoomIds(plan, devices, "execution"),
      deviceIds: targetDeviceIds(plan, deviceIds, "execution"),
    },
    preview: {
      roomIds: targetRoomIds(plan, devices, "preview"),
      deviceIds: targetDeviceIds(plan, deviceIds, "preview"),
    },
    alert: {
      roomIds: alertRoomIds(diagnostics, devices),
      deviceIds: alertDeviceIds(diagnostics, deviceIds),
    },
  };

  return {
    version: "0.1",
    order: LAYER_ORDER,
    layers,
    roomBadges: rooms.map((room) => ({
      roomId: room.id,
      layers: LAYER_ORDER.filter((layer) => layers[layer].roomIds.includes(room.id)),
    })),
    deviceBadges: devices.map((device) => ({
      deviceId: device.id,
      layers: LAYER_ORDER.filter((layer) => layers[layer].deviceIds.includes(device.id)),
    })),
  };
}

export function applyDigitalTwinLayersToScene(sceneModel, twinLayers) {
  if (!sceneModel || !twinLayers) return sceneModel;
  const roomLayerMap = new Map(twinLayers.roomBadges.map((badge) => [badge.roomId, badge.layers]));
  const deviceLayerMap = new Map(twinLayers.deviceBadges.map((badge) => [badge.deviceId, badge.layers]));
  return {
    ...sceneModel,
    stateLayers: twinLayers,
    rooms: (sceneModel.rooms ?? []).map((room) => ({
      ...room,
      layers: roomLayerMap.get(room.id) ?? [],
      selected: twinLayers.layers.selection.roomIds.includes(room.id),
      occupied: twinLayers.layers.occupancy.roomIds.includes(room.id),
    })),
    devices: (sceneModel.devices ?? []).map((device) => ({
      ...device,
      layers: deviceLayerMap.get(device.id) ?? [],
      preview: twinLayers.layers.preview.deviceIds.includes(device.id),
      executing: twinLayers.layers.execution.deviceIds.includes(device.id),
      alert: twinLayers.layers.alert.deviceIds.includes(device.id),
    })),
  };
}

function emptyLayer() {
  return { roomIds: [], deviceIds: [] };
}

function occupiedRoomIds(context, roomIds) {
  return (context?.spaces ?? [])
    .filter((space) => space.occupied && roomIds.has(space.id))
    .sort((first, second) => (second.confidence ?? 0) - (first.confidence ?? 0))
    .map((space) => space.id);
}

function targetDeviceIds(plan, deviceIds, layer) {
  if (!plan || planLayer(plan) !== layer) return [];
  return (plan.steps ?? [])
    .map((step) => step.logicalAssetId ?? step.deviceId)
    .filter((deviceId) => deviceIds.has(deviceId));
}

function targetRoomIds(plan, devices, layer) {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  return Array.from(
    new Set(
      targetDeviceIds(plan, new Set(devicesById.keys()), layer)
        .map((deviceId) => devicesById.get(deviceId)?.roomId)
        .filter(Boolean),
    ),
  );
}

function planLayer(plan) {
  const status = plan?.commandResult?.status;
  if (["dry_run", "needs_confirmation"].includes(status)) return "preview";
  if (["executing", "executed", "partial_failure"].includes(status)) return "execution";
  return null;
}

function alertDeviceIds(diagnostics, deviceIds) {
  return Array.from(
    new Set(
      (diagnostics?.findings ?? [])
        .filter((finding) => ["medium", "high", "critical"].includes(finding.severity))
        .flatMap((finding) => finding.targets ?? [])
        .map((target) => target.thingId)
        .filter((thingId) => deviceIds.has(thingId)),
    ),
  );
}

function alertRoomIds(diagnostics, devices) {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  return Array.from(
    new Set(alertDeviceIds(diagnostics, new Set(devicesById.keys())).map((deviceId) => devicesById.get(deviceId)?.roomId).filter(Boolean)),
  );
}
