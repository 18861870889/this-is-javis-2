import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createHouseSceneModel, getSceneRoomName } from "./houseSceneModel.js";
import { rooms } from "./simulator.js";

// ═══════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════

const CEILING_HEIGHT = 1.4;
const WALL_HEIGHT_DEFAULT = 1.1;
const WALL_HEIGHT_SELECTED = 0.35;
const WALL_THICKNESS = 0.12;
const WALL_OPACITY_DEFAULT = 0.88;
const WALL_OPACITY_SELECTED = 0.3;
const WALL_COLOR = 0xf5f5f0;
const WALL_COLOR_SELECTED = 0xb7dfd6;
const FLOOR_THICKNESS = 0.1;
const LABEL_Y = CEILING_HEIGHT + 0.2;
const DOT_Y = CEILING_HEIGHT + 0.1;

const STATUS_COLOR = {
  active: 0x22c55e,
  inactive: 0x94a3b8,
  alert: 0xef4444,
  executing: 0xf59e0b,
  preview: 0x2dd4bf,
};

const FLOOR_FALLBACK_COLOR = {
  entry: 0xe8e2d8,
  living: 0xc4a373,
  dining: 0xc4a373,
  kitchen: 0xe0e0e0,
  study: 0xa68a64,
  bedroom: 0xd4bc94,
  bath: 0xe0e0e0,
  balcony: 0xc4c4c4,
  generic: 0xd4d0c8,
};

const deviceOffsets = {
  entry_light: [0, 0],
  entry_motion: [0.75, -0.2],
  front_door: [-0.9, -0.55],
  living_light: [-0.5, -0.2],
  living_tv: [1.5, 0.9],
  living_curtain: [0.9, -1.25],
  living_camera: [1.78, -1.1],
  robot: [-1.25, 0.75],
  cat_feeder: [0.7, -0.6],
  kitchen_light: [0, -0.3],
  kitchen_fan: [0.62, 0.68],
  kitchen_presence: [-0.58, 0.72],
  study_light: [0, 0],
  study_ac: [0.72, 0.75],
  study_fan: [-0.68, -0.4],
  study_presence: [-0.85, 0.75],
  master_light: [-0.55, -0.25],
  master_ac: [0.82, 0.68],
  master_curtain: [0, -1.02],
  second_light: [-0.4, -0.1],
  second_ac: [0.62, 0.62],
  bath_light: [-0.3, -0.25],
  gas_heater: [0.45, 0.45],
  balcony_light: [-0.28, 0.05],
  drying_rack: [0.35, 0.65],
  washer: [-0.45, -0.62],
  dryer: [0.45, -0.62],
};

// ═══════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    }
  });
}

function createTextSprite(text, options = {}) {
  const {
    width = 360,
    height = 96,
    fontSize = 30,
    background = "rgba(255, 255, 255, 0.9)",
    foreground = "#183431",
    border = "rgba(55, 104, 97, 0.22)",
  } = options;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  roundRect(ctx, 0, 0, width, height, 22);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.fillStyle = foreground;
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = String(text).split("\n").slice(0, 2);
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, height / 2 + (index - (lines.length - 1) / 2) * (fontSize + 8));
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width / 130, height / 130, 1);
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function statusForDevice(device) {
  if (device.statusLabel) return device.statusLabel;
  switch (device.type) {
    case "light":
      return device.on ? `${device.brightness}%` : "关";
    case "ac":
      return device.on ? `${device.temperature}°C` : "关";
    case "fan":
      return device.on ? `${device.speed || 1}档` : "关";
    case "curtain":
      return `${safePercent(device.position, 0)}%`;
    case "tv":
      return device.on ? "开" : "关";
    case "robot_vacuum":
      return device.status === "cleaning" ? "清扫中" : "待命";
    case "pet_feeder":
      return `${device.portionsToday}份`;
    case "gas_heater":
      return device.on ? `${device.temperature}°C` : "关";
    case "presence_sensor":
    case "motion_sensor":
      return device.detected ? "有人" : "无人";
    case "door_sensor":
      return device.open ? "开启" : "关闭";
    case "camera":
      return device.privacyMode ? "隐私" : device.on ? "开启" : "关闭";
    case "washer":
    case "dryer":
      return device.status === "running" ? `${device.minutesLeft}m` : device.status;
    case "drying_rack":
      return device.on ? "通电" : "断电";
    default:
      return "";
  }
}

function devicePosition(device) {
  if (typeof device.sceneX === "number" && typeof device.sceneZ === "number") {
    return [device.sceneX, device.sceneZ];
  }
  const room = rooms.find((item) => item.id === device.roomId);
  if (!room) return [0, 0];
  const [ox, oz] = deviceOffsets[device.id] ?? [0, 0];
  return [room.x + ox, room.z + oz];
}

function isActive(device) {
  if (device.executing || device.preview) return true;
  if (device.source === "hcm") return Boolean(device.active);
  if ("on" in device) return device.on;
  if ("detected" in device) return device.detected;
  if ("open" in device) return device.open;
  if (device.type === "robot_vacuum") return device.status === "cleaning";
  if (["washer", "dryer"].includes(device.type)) return device.status === "running";
  if (device.type === "pet_feeder") return device.portionsToday > 0;
  return false;
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function safePercent(value, fallback) {
  return Math.max(0, Math.min(100, safeNumber(value, fallback)));
}

function getDeviceStatusColor(device, active) {
  if (device.alert) return STATUS_COLOR.alert;
  if (device.executing) return STATUS_COLOR.executing;
  if (device.preview) return STATUS_COLOR.preview;
  return active ? STATUS_COLOR.active : STATUS_COLOR.inactive;
}

// ═══════════════════════════════════════════════════
// Floor Textures
// ═══════════════════════════════════════════════════

const textureCache = new Map();

function createFloorTexture(roomType) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const isTile = roomType === "bath" || roomType === "kitchen";
  const isStone = roomType === "entry" || roomType === "balcony";

  if (isTile) {
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "#b8b8b8";
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
    }
  } else if (isStone) {
    ctx.fillStyle = "#d4cec4";
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "#b8b0a4";
    ctx.lineWidth = 1.5;
    for (let y = 0; y < 256; y += 64) {
      const offset = (Math.floor(y / 64) % 2) * 32;
      for (let x = -32; x < 256; x += 64) {
        ctx.strokeRect(x + offset, y, 64, 64);
      }
    }
  } else {
    const woodColors = { living: "#c4a373", dining: "#c4a373", study: "#a68a64", bedroom: "#d4bc94" };
    ctx.fillStyle = woodColors[roomType] || "#c4a373";
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "rgba(80,60,40,0.12)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 256; i += 32) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `rgba(60,40,20,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, Math.random() * 50 + 10, 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function getFloorTexture(roomType) {
  if (!textureCache.has(roomType)) {
    textureCache.set(roomType, createFloorTexture(roomType));
  }
  return textureCache.get(roomType);
}

// ═══════════════════════════════════════════════════
// Light Sub-Type Detection
// ═══════════════════════════════════════════════════

function getLightSubType(device) {
  const name = device.name || "";
  if (name.includes("吊灯")) return "pendant";
  if (name.includes("射灯")) return "spotlight";
  if (name.includes("灯带")) return "strip";
  if (name.includes("吸顶灯")) return "ceiling";
  if (name.includes("落地灯")) return "floor";
  return "ceiling";
}

// ═══════════════════════════════════════════════════
// Info Display: Status Dots
// ═══════════════════════════════════════════════════

function addDeviceStatusDot(group, device, x, z, active) {
  const color = getDeviceStatusColor(device, active);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  dot.position.set(x, DOT_Y, z);
  group.add(dot);
}

// ═══════════════════════════════════════════════════
// Room & Wall Builders
// ═══════════════════════════════════════════════════

function addRooms(group, sceneRooms, selectedRoomId, roomStats) {
  for (const room of sceneRooms) {
    const active = room.selected ?? room.id === selectedRoomId;
    const occupied = Boolean(room.occupied);
    const alert = room.layers?.includes("alert");
    const preview = room.layers?.includes("preview");
    const executing = room.layers?.includes("execution");
    const stats = roomStats.get(room.id) ?? { total: room.deviceCount ?? 0, active: 0 };
    const isPolygon = Array.isArray(room.polygonScenePoints) && room.polygonScenePoints.length >= 3;
    const mergedRects = Array.isArray(room.allRects) && room.allRects.length > 1 ? room.allRects : null;

    const texture = getFloorTexture(room.type).clone();
    if (isPolygon) {
      const bounds = room.polygonScenePoints.reduce(
        (acc, p) => ({ minX: Math.min(acc.minX, p.x), maxX: Math.max(acc.maxX, p.x), minZ: Math.min(acc.minZ, p.z), maxZ: Math.max(acc.maxZ, p.z) }),
        { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
      );
      texture.repeat.set(Math.max(1, (bounds.maxX - bounds.minX) / 2), Math.max(1, (bounds.maxZ - bounds.minZ) / 2));
    } else if (mergedRects) {
      const bounds = mergedRects.reduce(
        (acc, r) => ({ minX: Math.min(acc.minX, r.x - r.width / 2), maxX: Math.max(acc.maxX, r.x + r.width / 2), minZ: Math.min(acc.minZ, r.z - r.depth / 2), maxZ: Math.max(acc.maxZ, r.z + r.depth / 2) }),
        { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
      );
      texture.repeat.set(Math.max(1, (bounds.maxX - bounds.minX) / 2), Math.max(1, (bounds.maxZ - bounds.minZ) / 2));
    } else {
      texture.repeat.set(Math.max(1, room.width / 2), Math.max(1, room.depth / 2));
    }
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: active ? 0xcce9e2 : alert ? 0xf2d6d2 : (FLOOR_FALLBACK_COLOR[room.type] ?? 0xd4d0c8),
      map: texture,
      roughness: 0.78,
      metalness: 0.02,
      emissive: active ? 0x78bcae : alert ? 0xd88982 : preview ? 0x69b9aa : executing ? 0xd7a044 : 0x000000,
      emissiveIntensity: active || alert || preview || executing ? 0.06 : 0,
    });

    // Render floor(s): single rect, merged multi-rect, or polygon
    const floorMeshes = [];
    if (isPolygon) {
      const shape = new THREE.Shape();
      const pts = room.polygonScenePoints;
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      shape.closePath();
      const floorGeo = new THREE.ShapeGeometry(shape);
      floorGeo.rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(floorGeo, floorMaterial);
      floor.position.y = 0.05;
      floorMeshes.push(floor);
    } else if (mergedRects) {
      for (const r of mergedRects) {
        const floor = new THREE.Mesh(new THREE.BoxGeometry(r.width, FLOOR_THICKNESS, r.depth), floorMaterial);
        floor.position.set(r.x, 0, r.z);
        floorMeshes.push(floor);
      }
    } else {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(room.width, FLOOR_THICKNESS, room.depth), floorMaterial);
      floor.position.set(room.x, 0, room.z);
      floorMeshes.push(floor);
    }
    for (const floor of floorMeshes) {
      floor.receiveShadow = true;
      floor.userData.roomId = room.id;
      group.add(floor);
    }

    addWalls(group, room, active, mergedRects);

    const labelText = `${room.name} · ${stats.active}/${stats.total}`;
    const label = createTextSprite(labelText, {
      width: 240,
      height: 64,
      fontSize: 22,
      background: active ? "rgba(219, 242, 236, 0.92)" : "rgba(255, 255, 255, 0.85)",
      foreground: active ? "#126f65" : "#314b47",
      border: active ? "rgba(22, 143, 131, 0.44)" : "rgba(55, 104, 97, 0.18)",
    });
    label.position.set(room.x, LABEL_Y, room.z);
    group.add(label);

    if (occupied) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.36, 0.02, 12, 48),
        new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.72 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(room.x - room.width * 0.33, 0.06, room.z + room.depth * 0.32);
      group.add(ring);
    }

    if (!occupied && room.presence) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.28, 0.014, 12, 40),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(room.x - room.width * 0.33, 0.06, room.z + room.depth * 0.32);
      group.add(ring);
    }

    if (executing || preview || alert) addRoomLayerBadge(group, room, { executing, preview, alert });
  }
}

function addRoomLayerBadge(group, room, { executing, preview, alert }) {
  const color = alert ? 0xef4444 : executing ? 0xf59e0b : 0x2dd4bf;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(Math.min(room.width, room.depth) * 0.34, 0.025, 12, 72),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(room.x, 0.1, room.z);
  group.add(ring);
}

function addWalls(group, room, active, mergedRects = null) {
  const height = active ? WALL_HEIGHT_SELECTED : WALL_HEIGHT_DEFAULT;
  const opacity = active ? WALL_OPACITY_SELECTED : WALL_OPACITY_DEFAULT;
  const color = active ? WALL_COLOR_SELECTED : WALL_COLOR;
  const material = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity,
    roughness: 0.9,
    metalness: 0,
  });

  const isPolygon = Array.isArray(room.polygonScenePoints) && room.polygonScenePoints.length >= 3;
  if (isPolygon) {
    const pts = room.polygonScenePoints;
    for (let i = 0; i < pts.length; i++) {
      const next = pts[(i + 1) % pts.length];
      const dx = next.x - pts[i].x;
      const dz = next.z - pts[i].z;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.01) continue;
      const angle = Math.atan2(dz, dx);
      const midX = (pts[i].x + next.x) / 2;
      const midZ = (pts[i].z + next.z) / 2;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(length, height, WALL_THICKNESS), material.clone());
      wall.position.set(midX, height / 2, midZ);
      wall.rotation.y = -angle;
      wall.castShadow = true;
      wall.userData.roomId = room.id;
      group.add(wall);
    }
    return;
  }

  // For merged rooms, render walls per-rect but skip internal shared walls
  const rects = mergedRects ?? [{ x: room.x, z: room.z, width: room.width, depth: room.depth }];
  const tol = 0.12;
  for (const rect of rects) {
    const rectLeft = rect.x - rect.width / 2;
    const rectRight = rect.x + rect.width / 2;
    const rectTop = rect.z - rect.depth / 2;
    const rectBottom = rect.z + rect.depth / 2;
    // Each wall: [length, thickness, offsetX, offsetZ, side]
    // Check if this wall is shared with (overlaps) a wall of another rect in the group
    const segments = [
      [rect.width, WALL_THICKNESS, 0, -rect.depth / 2, "north", rectTop, "h", rectLeft, rectRight],
      [rect.width, WALL_THICKNESS, 0, rect.depth / 2, "south", rectBottom, "h", rectLeft, rectRight],
      [WALL_THICKNESS, rect.depth, -rect.width / 2, 0, "west", rectLeft, "v", rectTop, rectBottom],
      [WALL_THICKNESS, rect.depth, rect.width / 2, 0, "east", rectRight, "v", rectTop, rectBottom],
    ];
    for (const [w, d, ox, oz, side, wallPos, orient, rangeStart, rangeEnd] of segments) {
      if (isWallShared(wallPos, orient, rangeStart, rangeEnd, rects, rect, tol)) continue;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), material.clone());
      wall.position.set(rect.x + ox, height / 2, rect.z + oz);
      wall.castShadow = true;
      wall.userData.roomId = room.id;
      group.add(wall);
    }
  }
}

function isWallShared(wallPos, orient, rangeStart, rangeEnd, rects, excludeRect, tol) {
  for (const r of rects) {
    if (r === excludeRect) continue;
    const rLeft = r.x - r.width / 2;
    const rRight = r.x + r.width / 2;
    const rTop = r.z - r.depth / 2;
    const rBottom = r.z + r.depth / 2;
    if (orient === "h") {
      // Horizontal wall (north/south): check if any rect's north or south wall is at same z
      const matchTop = Math.abs(wallPos - rTop) < tol;
      const matchBottom = Math.abs(wallPos - rBottom) < tol;
      if (matchTop || matchBottom) {
        // Check x-range overlap
        const overlap = Math.min(rangeEnd, rRight) - Math.max(rangeStart, rLeft);
        if (overlap > tol) return true;
      }
    } else {
      // Vertical wall (west/east): check if any rect's west or east wall is at same x
      const matchLeft = Math.abs(wallPos - rLeft) < tol;
      const matchRight = Math.abs(wallPos - rRight) < tol;
      if (matchLeft || matchRight) {
        // Check z-range overlap
        const overlap = Math.min(rangeEnd, rBottom) - Math.max(rangeStart, rTop);
        if (overlap > tol) return true;
      }
    }
  }
  return false;
}

function isPointInAnyRect(px, pz, rects, excludeRect, tol = 0.05) {
  for (const r of rects) {
    if (r === excludeRect) continue;
    const insideX = px > r.x - r.width / 2 - tol && px < r.x + r.width / 2 + tol;
    const insideZ = pz > r.z - r.depth / 2 - tol && pz < r.z + r.depth / 2 + tol;
    if (insideX && insideZ) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════
// Furniture
// ═══════════════════════════════════════════════════

function addFurniture(group, sceneRooms) {
  const roomById = new Map(sceneRooms.map((room) => [room.id, room]));
  const mat = {
    bed: new THREE.MeshStandardMaterial({ color: 0xe6ddd3, roughness: 0.84 }),
    sofa: new THREE.MeshStandardMaterial({ color: 0xa9cec5, roughness: 0.86 }),
    table: new THREE.MeshStandardMaterial({ color: 0xcfae89, roughness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xb98d67, roughness: 0.82 }),
  };
  const living = roomById.get("living");
  const dining = roomById.get("dining");
  const master = roomById.get("master");
  const second = roomById.get("second");
  const catRoom = roomById.get("cat_room");
  const kitchen = roomById.get("kitchen");

  if (living) {
    addBox(group, [1.8, 0.4, 0.68], [living.x - 0.3, 0.2, living.z - 0.8], mat.sofa);
    addBox(group, [1.8, 0.3, 0.12], [living.x - 0.3, 0.55, living.z - 1.08], mat.sofa);
    addBox(group, [0.9, 0.4, 0.55], [living.x - 0.35, 0.2, living.z], mat.table);
    addBox(group, [0.95, 0.5, 0.18], [living.x + living.width * 0.32, 0.25, living.z + 0.2], mat.wood);
  }
  if (dining) addBox(group, [1.0, 0.75, 0.65], [dining.x, 0.375, dining.z], mat.table);
  if (master) {
    addBox(group, [1.55, 0.35, 1.05], [master.x, 0.175, master.z + 0.05], mat.bed);
    addBox(group, [1.55, 0.15, 0.1], [master.x, 0.35, master.z + 0.55], mat.wood);
  }
  if (second) {
    addBox(group, [1.25, 0.35, 0.95], [second.x, 0.175, second.z + 0.05], mat.bed);
    addBox(group, [1.25, 0.15, 0.1], [second.x, 0.35, second.z + 0.5], mat.wood);
  }
  if (catRoom) {
    addBox(group, [1.2, 0.3, 0.82], [catRoom.x - 0.15, 0.15, catRoom.z + 0.25], mat.bed);
  }
  if (kitchen) addBox(group, [0.55, 0.85, 1.5], [kitchen.x - kitchen.width * 0.25, 0.425, kitchen.z], mat.wood);
}

function addBox(group, size, position, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

// ═══════════════════════════════════════════════════
// Device Builders
// ═══════════════════════════════════════════════════

function addDevices(group, devices, selectedRoomId, animated) {
  for (const device of Object.values(devices)) {
    const [x, z] = devicePosition(device);
    const active = isActive(device);

    if (device.type === "light") {
      addLightDevice(group, device, x, z, animated);
    } else if (device.type === "fan") {
      addFanDevice(group, device, x, z, animated);
    } else if (device.type === "curtain") {
      addCurtainDevice(group, device, x, z);
    } else if (device.type === "tv") {
      addTvDevice(group, device, x, z);
    } else if (device.type === "ac") {
      addAcDevice(group, device, x, z);
    } else if (device.type === "switch_panel") {
      addPanelDevice(group, device, x, z, 0xfbbf24);
    } else if (device.type === "hub") {
      addPanelDevice(group, device, x, z, 0x5eead4);
    } else if (device.type === "scale") {
      addPanelDevice(group, device, x, z, 0xc4b5fd);
    } else if (device.type === "robot_vacuum") {
      addRobotDevice(group, device, x, z, animated);
    } else if (device.type === "camera") {
      addCameraDevice(group, device, x, z);
    } else if (device.type === "drying_rack") {
      addDryingRackDevice(group, device, x, z);
    } else if (["presence_sensor", "motion_sensor", "door_sensor"].includes(device.type)) {
      addSensorDevice(group, device, x, z, animated);
    } else {
      addGenericDevice(group, device, x, z);
    }

    addDeviceStatusDot(group, device, x, z, active);

    if (device.executing || device.preview || device.alert) addDeviceLayerRing(group, device, x, z);
  }
}

function addDeviceLayerRing(group, device, x, z) {
  const color = device.alert ? 0xef4444 : device.executing ? 0xf59e0b : 0x2dd4bf;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.018, 12, 44),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.76 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, 0.05, z);
  group.add(ring);
}

// ── Light: dispatch by sub-type ──

function addLightDevice(group, device, x, z, animated) {
  const subType = getLightSubType(device);
  if (subType === "pendant") addPendantLight(group, device, x, z, animated);
  else if (subType === "spotlight") addSpotlightLight(group, device, x, z, animated);
  else if (subType === "strip") addStripLight(group, device, x, z, animated);
  else if (subType === "floor") addFloorLamp(group, device, x, z, animated);
  else addCeilingLight(group, device, x, z, animated);
}

function addPendantLight(group, device, x, z, animated) {
  const on = device.on;
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.3, 8),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.6, roughness: 0.3 }),
  );
  rod.position.set(x, CEILING_HEIGHT - 0.15, z);
  group.add(rod);

  const shadeMat = new THREE.MeshStandardMaterial({
    color: on ? 0xfff2ad : 0x808080,
    emissive: on ? 0xffa726 : 0x000000,
    emissiveIntensity: on ? 1.0 : 0,
    roughness: 0.3,
    transparent: true,
    opacity: 0.75,
  });
  const shade = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 24, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    shadeMat,
  );
  shade.position.set(x, CEILING_HEIGHT - 0.35, z);
  group.add(shade);
  animated.push({ kind: "light", object: shade, active: on });

  if (on) {
    const light = new THREE.PointLight(0xffb74d, Math.max(0.5, safeNumber(device.brightness, 60) / 80), 3);
    light.position.set(x, CEILING_HEIGHT - 0.4, z);
    group.add(light);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb84d, transparent: true, opacity: 0.1 }),
    );
    glow.position.set(x, CEILING_HEIGHT - 0.4, z);
    group.add(glow);
  }
}

function addSpotlightLight(group, device, x, z, animated) {
  const on = device.on;
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.04, 16),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4 }),
  );
  housing.position.set(x, CEILING_HEIGHT - 0.02, z);
  group.add(housing);

  const lensMat = new THREE.MeshStandardMaterial({
    color: on ? 0xfff2ad : 0x666666,
    emissive: on ? 0xffa726 : 0x000000,
    emissiveIntensity: on ? 0.8 : 0,
    roughness: 0.2,
  });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.04, 16), lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(x, CEILING_HEIGHT - 0.04, z + 0.001);
  group.add(lens);
  animated.push({ kind: "light", object: lens, active: on });

  if (on) {
    const spot = new THREE.SpotLight(0xffb74d, 0.8, 3, Math.PI / 6, 0.4);
    spot.position.set(x, CEILING_HEIGHT - 0.05, z);
    spot.target.position.set(x, 0, z);
    group.add(spot);
    group.add(spot.target);
  }
}

function addStripLight(group, device, x, z, animated) {
  const on = device.on;
  const stripMat = new THREE.MeshStandardMaterial({
    color: on ? 0xfff2ad : 0x444444,
    emissive: on ? 0xffd060 : 0x000000,
    emissiveIntensity: on ? 1.2 : 0,
    roughness: 0.3,
  });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.04), stripMat);
  strip.position.set(x, CEILING_HEIGHT - 0.2, z);
  group.add(strip);
  animated.push({ kind: "light", object: strip, active: on });

  if (on) {
    const light = new THREE.PointLight(0xffd080, 0.4, 2);
    light.position.set(x, CEILING_HEIGHT - 0.25, z);
    group.add(light);
  }
}

function addCeilingLight(group, device, x, z, animated) {
  const on = device.on;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.15, 0.03, 24),
    new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.5 }),
  );
  base.position.set(x, CEILING_HEIGHT - 0.015, z);
  group.add(base);

  const shadeMat = new THREE.MeshStandardMaterial({
    color: on ? 0xfff2ad : 0x808080,
    emissive: on ? 0xffa726 : 0x000000,
    emissiveIntensity: on ? 1.0 : 0,
    roughness: 0.3,
    transparent: true,
    opacity: 0.7,
  });
  const shade = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 24, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    shadeMat,
  );
  shade.position.set(x, CEILING_HEIGHT - 0.06, z);
  group.add(shade);
  animated.push({ kind: "light", object: shade, active: on });

  if (on) {
    const light = new THREE.PointLight(0xffb74d, Math.max(0.5, safeNumber(device.brightness, 60) / 80), 3);
    light.position.set(x, CEILING_HEIGHT - 0.1, z);
    group.add(light);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb84d, transparent: true, opacity: 0.08 }),
    );
    glow.position.set(x, CEILING_HEIGHT - 0.1, z);
    group.add(glow);
  }
}

function addFloorLamp(group, device, x, z, animated) {
  const on = device.on;
  const poleHeight = CEILING_HEIGHT * 0.65;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 0.03, 16),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 }),
  );
  base.position.set(x, 0.015, z);
  group.add(base);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, poleHeight, 8),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.5, roughness: 0.3 }),
  );
  pole.position.set(x, 0.03 + poleHeight / 2, z);
  group.add(pole);

  const shadeMat = new THREE.MeshStandardMaterial({
    color: on ? 0xfff2ad : 0x808080,
    emissive: on ? 0xffa726 : 0x000000,
    emissiveIntensity: on ? 1.0 : 0,
    roughness: 0.3,
    transparent: true,
    opacity: 0.7,
  });
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.15, 16, 1, true), shadeMat);
  shade.position.set(x, 0.03 + poleHeight, z);
  group.add(shade);
  animated.push({ kind: "light", object: shade, active: on });

  if (on) {
    const light = new THREE.PointLight(0xffb74d, 0.6, 2.5);
    light.position.set(x, 0.03 + poleHeight - 0.1, z);
    group.add(light);
  }
}

// ── Drying rack: wall-mounted horizontal pole ──

function addDryingRackDevice(group, device, x, z) {
  const on = device.on;
  const poleLength = 1.2;
  const mountHeight = CEILING_HEIGHT * 0.72;
  const metalMat = new THREE.MeshStandardMaterial({
    color: on ? 0xc0c0c0 : 0x808080,
    metalness: 0.7,
    roughness: 0.25,
  });

  // Two wall brackets
  const bracketGeo = new THREE.BoxGeometry(0.035, 0.06, 0.035);
  for (const ox of [-poleLength / 2, poleLength / 2]) {
    const bracket = new THREE.Mesh(bracketGeo, metalMat);
    bracket.position.set(x + ox, mountHeight, z - 0.02);
    group.add(bracket);
  }

  // Horizontal pole
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, poleLength, 12),
    metalMat,
  );
  pole.rotation.z = Math.PI / 2;
  pole.position.set(x, mountHeight, z);
  group.add(pole);

  // Small end caps
  const capGeo = new THREE.SphereGeometry(0.016, 8, 8);
  for (const ox of [-poleLength / 2, poleLength / 2]) {
    const cap = new THREE.Mesh(capGeo, metalMat);
    cap.position.set(x + ox, mountHeight, z);
    group.add(cap);
  }

  // Indicator stripe when powered
  if (on) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(poleLength * 0.3, 0.004, 0.004),
      new THREE.MeshBasicMaterial({ color: 0x34d399 }),
    );
    stripe.position.set(x, mountHeight + 0.014, z);
    group.add(stripe);
  }
}

// ── Fan: ceiling fan ──

function addFanDevice(group, device, x, z, animated) {
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.25, 8),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.5, roughness: 0.3 }),
  );
  rod.position.set(x, CEILING_HEIGHT - 0.125, z);
  group.add(rod);

  const motor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.08, 16),
    new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5, roughness: 0.3 }),
  );
  motor.position.set(x, CEILING_HEIGHT - 0.29, z);
  group.add(motor);

  const hub = new THREE.Group();
  hub.position.set(x, CEILING_HEIGHT - 0.33, z);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.015, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.7 }),
    );
    blade.position.x = 0.18;
    blade.rotation.y = (Math.PI * 2 * i) / 3;
    hub.add(blade);
  }
  group.add(hub);
  animated.push({ kind: "fan", object: hub, active: device.on });
}

// ── Curtain ──

function addCurtainDevice(group, device, x, z) {
  const openness = safePercent(device.position, 0) / 100;
  const railY = CEILING_HEIGHT - 0.05;
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 0.03, 0.04),
    new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.3, roughness: 0.4 }),
  );
  rail.position.set(x, railY, z);
  group.add(rail);

  const curtainHeight = CEILING_HEIGHT - 0.25;
  const curtainWidth = Math.max(0.12, 0.64 * (1 - openness));
  const curtainMat = new THREE.MeshStandardMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.72,
    roughness: 0.62,
  });
  const left = new THREE.Mesh(new THREE.BoxGeometry(curtainWidth, curtainHeight, 0.03), curtainMat);
  const right = new THREE.Mesh(new THREE.BoxGeometry(curtainWidth, curtainHeight, 0.03), curtainMat.clone());
  const curtainY = railY - curtainHeight / 2 - 0.02;
  left.position.set(x - 0.38, curtainY, z);
  right.position.set(x + 0.38, curtainY, z);
  group.add(left, right);
}

// ── TV: stand + screen ──

function addTvDevice(group, device, x, z) {
  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.45, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
  );
  stand.position.set(x, 0.225, z);
  group.add(stand);

  const screenMat = new THREE.MeshStandardMaterial({
    color: device.on ? 0x1a1a2e : 0x050510,
    emissive: device.on ? 0x0ea5e9 : 0x000000,
    emissiveIntensity: device.on ? 0.6 : 0,
    roughness: 0.2,
  });
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), screenMat);
  screen.position.set(x, 0.75, z);
  screen.castShadow = true;
  group.add(screen);

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.94, 0.54, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }),
  );
  frame.position.set(x, 0.75, z - 0.005);
  group.add(frame);
}

// ── AC: wall-mounted split unit ──

function addAcDevice(group, device, x, z) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.2), bodyMat);
  body.position.set(x, CEILING_HEIGHT - 0.5, z);
  body.castShadow = true;
  group.add(body);

  const vent = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.02, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 }),
  );
  vent.position.set(x, CEILING_HEIGHT - 0.58, z + 0.08);
  group.add(vent);

  if (device.on) {
    const indicator = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x22c55e }),
    );
    indicator.position.set(x + 0.22, CEILING_HEIGHT - 0.54, z + 0.08);
    group.add(indicator);
  }
}

// ── Switch panel / hub / scale ──

function addPanelDevice(group, device, x, z, accent) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.04),
    new THREE.MeshStandardMaterial({
      color: device.on ? accent : 0x475569,
      emissive: device.on ? accent : 0x000000,
      emissiveIntensity: device.on ? 0.2 : 0,
      roughness: 0.44,
    }),
  );
  body.position.set(x, 1.3, z);
  body.castShadow = true;
  group.add(body);
}

// ── Robot vacuum ──

function addRobotDevice(group, device, x, z, animated) {
  const robot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.08, 36),
    new THREE.MeshStandardMaterial({
      color: device.status === "cleaning" ? 0x22c55e : 0x4a4a4a,
      roughness: 0.36,
      metalness: 0.25,
    }),
  );
  robot.position.set(x, 0.04, z);
  robot.castShadow = true;
  group.add(robot);
  animated.push({ kind: "robot", object: robot, active: device.status === "cleaning" });
}

// ── Camera ──

function addCameraDevice(group, device, x, z) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.1, 0.06),
    new THREE.MeshStandardMaterial({
      color: device.privacyMode ? 0x475569 : 0x111111,
      roughness: 0.5,
    }),
  );
  body.position.set(x, CEILING_HEIGHT - 0.3, z);
  group.add(body);

  const lens = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 12, 12),
    new THREE.MeshBasicMaterial({
      color: device.on && !device.privacyMode ? 0x67e8f9 : 0x334155,
    }),
  );
  lens.position.set(x, CEILING_HEIGHT - 0.3, z - 0.04);
  group.add(lens);
}

// ── Sensor: ceiling disc + LED ──

function addSensorDevice(group, device, x, z, animated) {
  const active = isActive(device);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16),
    new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.5 }),
  );
  base.position.set(x, CEILING_HEIGHT - 0.01, z);
  group.add(base);

  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 12, 12),
    new THREE.MeshBasicMaterial({
      color: active ? 0x22c55e : 0x666666,
    }),
  );
  led.position.set(x, CEILING_HEIGHT + 0.01, z);
  group.add(led);

  if (active) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.1, 0.008, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, CEILING_HEIGHT + 0.02, z);
    group.add(ring);
    animated.push({ kind: "sensor", object: ring, active });
  }
}

// ── Generic: floor appliance ──

function addGenericDevice(group, device, x, z) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.35, 24),
    new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.48,
    }),
  );
  mesh.position.set(x, 0.175, z);
  mesh.castShadow = true;
  group.add(mesh);
}

// ═══════════════════════════════════════════════════
// React Component
// ═══════════════════════════════════════════════════

export default function ThreeHouse({ devices, sceneModel, selectedRoomId, onSelectRoom }) {
  const model = useMemo(
    () => sceneModel ?? createHouseSceneModel({ simulatorRooms: rooms, simulatorDevices: devices }),
    [devices, sceneModel],
  );
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const houseGroupRef = useRef(null);
  const animatedRef = useRef([]);
  const onSelectRoomRef = useRef(onSelectRoom);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());

  useEffect(() => {
    onSelectRoomRef.current = onSelectRoom;
  }, [onSelectRoom]);

  useEffect(() => {
    const container = containerRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f7f5);
    scene.fog = new THREE.Fog(0xf2f7f5, 18, 40);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
    camera.position.set(6.5, 7.5, 7.0);
    camera.lookAt(0, 0.7, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.minDistance = 6;
    controls.maxDistance = 20;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.target.set(0, 0.7, 0);
    controlsRef.current = controls;

    const ambient = new THREE.HemisphereLight(0xffffff, 0xc3d5d0, 2.15);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff8e8, 2.55);
    sun.position.set(5, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    const rim = new THREE.DirectionalLight(0x82d8c5, 0.72);
    rim.position.set(-7, 5, -3);
    scene.add(rim);

    const grid = new THREE.GridHelper(18, 18, 0xcadbd6, 0xe2ece9);
    grid.position.y = -0.06;
    scene.add(grid);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const handleClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const intersects = raycasterRef.current.intersectObjects(scene.children, true);
      const roomHit = intersects.find((hit) => hit.object.userData?.roomId);
      if (roomHit) onSelectRoomRef.current?.(roomHit.object.userData.roomId);
    };
    renderer.domElement.addEventListener("click", handleClick);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const time = performance.now() / 1000;
      for (const item of animatedRef.current) {
        if (item.kind === "fan" && item.active) item.object.rotation.y += 0.16;
        if (item.kind === "sensor" && item.active) {
          const scale = 1 + Math.sin(time * 4) * 0.12;
          item.object.scale.set(scale, scale, scale);
        }
        if (item.kind === "robot" && item.active) {
          item.object.position.x += Math.sin(time * 1.8) * 0.003;
          item.object.position.z += Math.cos(time * 1.6) * 0.003;
          item.object.rotation.y += 0.03;
        }
        if (item.kind === "light" && item.active) {
          item.object.material.emissiveIntensity = 1.0 + Math.sin(time * 3) * 0.08;
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      renderer.domElement.removeEventListener("click", handleClick);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (houseGroupRef.current) {
      scene.remove(houseGroupRef.current);
      disposeObject(houseGroupRef.current);
    }

    animatedRef.current = [];
    const house = new THREE.Group();
    house.name = "harness-house-model";
    scene.add(house);
    houseGroupRef.current = house;

    const deviceList = Object.values(model.devices);
    const roomStats = new Map();
    for (const device of deviceList) {
      const roomId = device.roomId;
      if (!roomStats.has(roomId)) {
        roomStats.set(roomId, { total: 0, active: 0 });
      }
      const stats = roomStats.get(roomId);
      stats.total++;
      if (isActive(device)) stats.active++;
    }

    addRooms(house, model.rooms, selectedRoomId, roomStats);
    addFurniture(house, model.rooms);
    addDevices(house, model.devices, selectedRoomId, animatedRef.current);
  }, [model, selectedRoomId]);

  return (
    <div className="scene-shell" ref={containerRef}>
      <div className="scene-hud">
        <span>{model.source === "hcm" ? "3D HCM House" : "3D Simulated House"}</span>
        <strong>{selectedRoomId ? getSceneRoomName(selectedRoomId, model.rooms) : "全屋"}</strong>
      </div>
      <div className="scene-legend">
        <span className="dot dot-active" /> 活跃
        <span className="dot dot-inactive" /> 关闭
        <span className="dot dot-alert" /> 告警
      </div>
      <div className="scene-controls-hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>
    </div>
  );
}
