const baseUrl = process.env.JARVIS_URL || "http://127.0.0.1:5173";
const iterations = positiveInteger(process.env.JARVIS_LATENCY_ITERATIONS, 10);
const duplicateBudgetMs = positiveInteger(process.env.JARVIS_DUPLICATE_P95_MS, 100);
const fastPathBudgetMs = positiveInteger(process.env.JARVIS_FAST_PATH_P95_MS, 1000);
const runFastPath = process.env.JARVIS_LATENCY_FAST_PATH === "1";
const duplicateDeviceA = process.env.JARVIS_LATENCY_DEVICE_A || "latency-a";
const duplicateDeviceB = process.env.JARVIS_LATENCY_DEVICE_B || "latency-b";
const duplicateRoomId = process.env.JARVIS_LATENCY_ROOM_ID || "";
const duplicateText = process.env.JARVIS_LATENCY_DUPLICATE_TEXT || "延迟测试请忽略";
const fastPathDeviceId = process.env.JARVIS_LATENCY_FAST_PATH_DEVICE_ID || "latency-study";
const fastPathRoomId = process.env.JARVIS_LATENCY_FAST_PATH_ROOM_ID || "study";
const fastPathText = process.env.JARVIS_LATENCY_FAST_PATH_TEXT || "打开书房射灯";

const duplicateSamples = [];
for (let index = 0; index < iterations; index += 1) {
  const wakeSessionId = `latency-duplicate-${Date.now()}-${index}`;
  await postUtterance({
    deviceId: duplicateDeviceA,
    roomId: duplicateRoomId,
    wakeSessionId,
    text: duplicateText,
    dryRun: true,
  });
  duplicateSamples.push(await timedPost({
    deviceId: duplicateDeviceB,
    roomId: duplicateRoomId,
    wakeSessionId,
    text: duplicateText,
    dryRun: true,
  }));
}
report("duplicate", duplicateSamples, duplicateBudgetMs);
assertRoutes("duplicate", duplicateSamples, new Set(["duplicate_ignored"]));

if (runFastPath) {
  const fastPathSamples = [];
  for (let index = 0; index < iterations; index += 1) {
    fastPathSamples.push(await timedPost({
      deviceId: fastPathDeviceId,
      roomId: fastPathRoomId,
      wakeSessionId: `latency-fast-${Date.now()}-${index}`,
      text: fastPathText,
      dryRun: true,
    }));
  }
  report("hcm_fast_path", fastPathSamples, fastPathBudgetMs);
  assertRoutes("hcm_fast_path", fastPathSamples, new Set(["hcm_fast_path"]));
}

async function timedPost(payload) {
  const startedAt = performance.now();
  const response = await postUtterance(payload);
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    status: response.status,
    route: response.route,
  };
}

async function postUtterance(payload) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/utterance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return json;
}

function report(name, samples, budgetMs) {
  const latencies = samples.map((sample) => sample.latencyMs).sort((first, second) => first - second);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const ok = p95 <= budgetMs;
  console.log(JSON.stringify({
    name,
    iterations: samples.length,
    p50,
    p95,
    budgetMs,
    ok,
    routes: countBy(samples.map((sample) => sample.route)),
    statuses: countBy(samples.map((sample) => sample.status)),
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

function assertRoutes(name, samples, allowedRoutes) {
  const unexpected = samples.filter((sample) => !allowedRoutes.has(sample.route));
  if (unexpected.length === 0) return;
  console.error(JSON.stringify({
    name,
    error: "unexpected_routes",
    allowedRoutes: Array.from(allowedRoutes),
    unexpected,
  }, null, 2));
  process.exitCode = 1;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}
