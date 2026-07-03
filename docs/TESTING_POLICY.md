# Testing Policy

> Harness House 的测试必须保护真实家庭环境。自动化测试默认只读或模拟。

## 1. 测试分层

```text
Unit Tests
  HCM schema / planner / intent accuracy / safety / policy / service mapping

Contract Tests
  Adapter raw graph -> HCM

Simulation Tests
  Command -> HCM plan -> policy gate -> simulated service result

Read-only Provider Tests
  HA states / registry / supported_features snapshot

Manual Real-device Tests
  User-authorized only
```

场景级 benchmark 见 [TEST_CASES.md](TEST_CASES.md)。

## 2. 默认禁止

自动化测试、Codex 调试和 CI 默认禁止：

- 调用 HA `/api/services/*` 真实服务。
- 点击 UI 中会真实控制设备的按钮。
- 修改 HA 配置、自动化、helper、entity registry。
- 启动燃气、门锁、摄像头隐私相关动作。

## 3. 默认允许

无需额外授权可以：

- 读取 HA states。
- 读取 HA area / device / entity registry。
- 调用 Harness House dry-run endpoint。
- 使用 simulator adapter。
- 使用 HomeAssistantServiceSimulator。
- 回放 audit command，但必须强制 dry-run。

## 4. 真实设备测试门槛

只有用户明确授权后，才能执行真实设备动作。

真实控制前必须确认：

- 目标设备名称。
- 房间。
- entity id。
- action / service。
- 风险等级。
- 是否可能产生物理副作用。

## 5. 必测回归

每次改动以下模块都必须跑完整测试：

- `src/hcm*.js`
- `src/command*.js`
- `src/planValidator.js`
- `src/hcmExecutor.js`
- `src/hcmOverlay.js`
- `src/intentAccuracyEngine.js`
- `src/policyEngine.js`
- `src/digitalTwinLayers.js`
- `src/providerOnboarding.js`
- `src/speechRuntime.js`
- `src/automationSuggestionEngine.js`
- `src/adapters/*.js`

命令：

```bash
npm test
npm run test:adapter
npm run build
```

## 6. 失败复盘模板

当真实设备或模拟 service 映射失败时，记录：

```text
User command:
Expected behavior:
Actual behavior:
Command path:
HCM thing:
Capability:
Provider entity:
Provider attributes:
Selected service:
Why selected:
Root cause:
Regression test:
```

## 7. 当前经验

`小爱音箱停止播放音乐` 的失败证明：

- domain 不是能力边界。
- 同一 `media_player` 可能支持 pause，不支持 stop。
- executor 必须参考 provider 真实能力。
- 自动化调试应先模拟 service，不应直接试真实设备。

`v0.12-v0.14` 的测试经验：

- LLM 输出不能直接进入执行，必须经过 Intent Accuracy Engine。
- Safety Gate 和 Policy Gate 要分开测，前者管能力是否可执行，后者管当前上下文是否应执行。
- Digital Twin 的 selection、occupancy、preview、execution、alert 是不同状态层，不能混用。
- Provider onboarding 只能生成 proposal，不能自动写 overlay 开放真实设备。
- STT 低置信度、空文本和 provider 失败不能自动执行。
- TTS 输出不能回流成新命令。
- 自动化建议必须至少来自两次匹配成功行为，并保持 shadow mode。
- Adapter Contract Harness 只能调用 discovery、HCM mapping、read、compile 和 simulate，不能调用 execute。
- Provider execute 必须同时需要 runtime authorization、匹配 command fingerprint 的成功 simulation 和 command ID。
- Provider snapshot 和 capability evidence 不得包含 token、password、authorization 或 API key。
