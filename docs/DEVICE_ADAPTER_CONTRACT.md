# Device Adapter Contract

> Provider 可以变化，Harness House 的上层只依赖 HCM。

## 1. Adapter 职责

Adapter 负责把外部系统转换成 Harness Capability Model，不负责业务决策。

```text
Provider Raw Graph
  -> Adapter Discovery
  -> HCM Spaces / Things / Capabilities / States
  -> Provider Snapshot Diff
  -> Onboarding Plan
  -> Overlay Policy
  -> Planner / Intent Accuracy / Safety / Policy / Runtime
```

Adapter 必须提供：

- provider id 和连接状态。
- space / room 映射。
- thing / physical device 聚合。
- capability 列表。
- state 快照。
- capability 的证据来源。
- provider raw id 到 HCM binding 的稳定映射。
- snapshot hash 和 diff 所需的稳定 identity。

代码契约为 `1.0`，要求实现：

```js
identity()
getConnectionStatus()
discoverSnapshot()
discoverHcmHome()
compileAction(action)
simulate(command)
execute(command, context)
readState(targetId)
subscribe?(handler)
```

详细 SDK、Snapshot 和执行约束见 [ADAPTER_SDK.md](ADAPTER_SDK.md)。

## 2. HCM Thing 最小字段

```json
{
  "id": "thing_living_room_ac",
  "name": "客厅空调",
  "spaceId": "living_room",
  "type": "climate",
  "provider": "home_assistant",
  "bindings": [
    {
      "providerId": "ha",
      "entityId": "climate.living_room_ac",
      "capabilityId": "set_temperature"
    }
  ],
  "capabilities": [],
  "state": {}
}
```

## 3. Capability 最小字段

```json
{
  "id": "set_temperature",
  "name": "设置温度",
  "kind": "control",
  "valueType": "number",
  "min": 16,
  "max": 30,
  "unit": "celsius",
  "risk": "medium",
  "confirmation": "never",
  "autoExecutable": true,
  "evidence": {
    "providerId": "home_assistant",
    "targetId": "climate.living_room_ac",
    "source": "registry_and_state",
    "commands": ["climate.set_temperature"],
    "constraints": { "min": 16, "max": 30 },
    "confidence": 0.95
  }
}
```

## 4. 风险默认值

| 类型 | 默认策略 |
| --- | --- |
| light / fan / low-risk cover | 可自动执行 |
| climate temperature | 可自动执行但需范围校验 |
| media player pause / volume | 可自动执行 |
| switch unknown | 默认禁止，除非 overlay 明确确认 |
| camera | 禁止自动执行 |
| gas / water heater | 禁止自动执行或必须确认 |
| lock / door | 禁止自动执行 |
| number / select / text / config | 禁止自动执行 |
| sensor / binary_sensor | 只读 |

## 5. Service 选择规则

Adapter 可以声明候选 command；Provider-specific command 由 `compileAction()` 生成，是否允许执行仍由 HCM、Safety Gate 和 Policy Gate 决定。

要求：

- 不能只根据 domain 推断完整能力。
- 必须参考 state、attributes、supported_features、registry 和 provider 文档。
- 不支持的 service 在 dry-run 中应返回 `unsupported`。
- 真实执行前必须重新校验当前 provider state。
- `execute()` 必须拒绝缺少 authorization、成功 simulation 或 command ID 的调用。

## 6. Provider 变动感知与 Onboarding

Adapter 应支持 snapshot hash：

```text
states + device_registry + entity_registry + area_registry
  -> normalized snapshot
  -> hash
  -> diff
  -> HCM update
```

变更分类：

- 新设备：进入 HCM，并由 `planProviderOnboarding` 分类为 `allow_auto_candidate` / `review` / `protect` / `read_only`。
- 删除设备：生成 `remove_from_planner`，防止 LLM 继续使用不存在能力；overlay 不应被静默清空。
- 重命名：保留 binding id，更新 display name。
- capability 变化：重新计算 risk 和 autoExecutable。
- 房间变化：更新 spaceId，并提示 UI 同步 3D 分布。

Onboarding 约束：

- 只能生成 proposal，不能自动开放真实设备。
- 低风险明确设备可以成为 `allow_auto_candidate`。
- 高风险、隐私、配置、文本、密码、语义不清设备默认 `protect` 或 `review`。
- simulation probe 必须使用本地 HA Service Simulator，不控制真实设备。

## 7. Adapter 验收

新增或修改 adapter 必须通过：

- discovery mock test。
- provider raw graph -> HCM snapshot test。
- capability risk test。
- unsupported service dry-run test。
- provider unavailable fallback test。
- 不实际控制真实设备的 command replay test。
- provider diff / onboarding planner test。
