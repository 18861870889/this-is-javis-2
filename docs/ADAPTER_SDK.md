# Harness House Adapter SDK 1.0

> Provider 负责把外部设备系统翻译成 HCM；Planner、Policy、Audit 和 3D UI 不读取 Provider 原始结构。

## Required Contract

每个 Adapter 必须实现：

```js
{
  identity(),
  getConnectionStatus(),
  discoverSnapshot(),
  discoverHcmHome(),
  compileAction(action),
  simulate(command),
  execute(command, context),
  readState(targetId),
  subscribe?(handler)
}
```

- `discoverSnapshot()` 返回 Provider Snapshot `1.0`，用于稳定 identity、diff 和 onboarding。
- `discoverHcmHome()` 完成 Provider Raw Graph 到 HCM 的映射。
- `compileAction()` 把 HCM action 编译为 Provider Command，不负责决定是否允许执行。
- `simulate()` 只验证当前能力、状态、参数和 Provider command，不产生外部副作用。
- `execute()` 必须校验 runtime authorization、成功 simulation、command fingerprint 和 command ID。

## Snapshot Schema

```json
{
  "version": "1.0",
  "provider": {
    "id": "example_provider",
    "name": "Example Provider",
    "version": "1.0",
    "transport": "mqtt"
  },
  "capturedAt": "2026-06-18T00:00:00.000Z",
  "spaces": [],
  "devices": [],
  "entities": [],
  "states": [],
  "metadata": {}
}
```

`externalId` 必须稳定，不能使用显示名称。重命名或换房间时 ID 保持不变；删除后产生 removed diff。

## Capability Evidence

HCM capability 应提供：

```json
{
  "providerId": "example_provider",
  "targetId": "device-123",
  "source": "registry_and_state",
  "capability": "set_temperature",
  "observations": {
    "deviceClass": "climate",
    "supportedFeatures": 385
  },
  "commands": ["climate.set_temperature"],
  "constraints": {
    "min": 16,
    "max": 30,
    "unit": "C"
  },
  "confidence": 0.95
}
```

名称推断不能作为唯一证据。语义不清、高风险、隐私或配置能力必须进入 review/protect。

## Starting A New Adapter

使用 [`providerAdapterTemplate.js`](../src/adapters/providerAdapterTemplate.js) 组合 Provider driver，再注册到 `ProviderAdapterRegistry`。参考实现：

- [`simulatorAdapter.js`](../src/adapters/simulatorAdapter.js)
- [`homeAssistantAdapter.js`](../src/adapters/homeAssistantAdapter.js)

运行专项门禁：

```bash
npm run test:adapter
```

Contract Harness 只调用 discovery、HCM mapping、read、compile 和 simulate，不调用 execute。

## Execution Boundary

```text
HCM Action
  -> Intent Accuracy
  -> Safety Gate
  -> Policy Gate
  -> Adapter.compileAction
  -> Adapter.simulate
  -> Adapter.execute({ authorized, matchingSimulation, commandId })
  -> Audit
```

`hcmExecutor` accepts both HA entity bindings and provider-neutral `{ provider, targetId, operation }` bindings. Provider-specific service or cluster compilation stays inside the active Adapter.

禁止通过 Provider 原始 API 暴露直连控制路由。Provider 凭据不能进入 snapshot、evidence、日志或前端响应。
