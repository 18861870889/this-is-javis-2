# Home Assistant Debugging Policy

## 背景

`小爱音箱停止播放音乐` 暴露了一个关键问题：Harness House 不能只根据 HA entity domain 做粗粒度 service 映射。

当时系统看到 `media_player.xiaomi_cn_800098769_lx06`，先后尝试过：

- `media_player.turn_off`
- `media_player.media_stop`

但该实体真实支持的是 `media_player.media_pause`。根因是 executor 没有读取并利用 HA entity 的 `supported_features`，而是把 `media_player + false` 简化映射成了固定服务。

## 核心经验

- 不要用 domain 直接推断完整能力边界。
- HA entity 的真实可用动作必须来自 entity state、attributes、supported_features、device registry、entity registry 和 provider 特征。
- 对同一个 domain，不同厂商、不同集成、不同设备型号的 service 支持可能不同。
- LLM 只能做意图理解，不能决定 HA service 细节。
- Service 选择必须由本地 deterministic executor 完成，并且可测试。
- 真实执行前还必须通过 Policy Gate 和 HA Service Simulator。

## 自动化调试规则

默认情况下，Codex 和自动化测试不得实际控制 Home Assistant 里的真实设备。

允许的默认调试方式：

- `dryRun=true` 调用 `/api/hcm/command`。
- 读取 `/api/hcm/home`、HA states、entity registry、device registry、area registry。
- 基于当前 HA graph 构造本地 mock/simulator。
- 用模拟 service executor 验证 service 映射。
- 用单元测试覆盖具体实体能力映射。

需要用户明确授权后才允许：

- 调用真实 `/api/services/*`。
- 通过 UI 触发真实设备动作。
- 修改真实设备状态、配置或自动化。

## 当前模拟层

当前已实现 `HomeAssistantServiceSimulator`，并接入真实 HCM command pipeline，位置在 `policy_gate` 之后、`device_executor` 之前：

- 输入：HCM action、HA entity state、supported_features、service call。
- 输出：would_execute / rejected / unsupported，并给出原因。
- 覆盖常见 domain：
  - `light`
  - `switch`
  - `fan`
  - `cover`
  - `climate`
  - `media_player`
  - `button`
- 对 `media_player` 必须基于 `supported_features` 选择 `media_play`、`media_pause`、`media_stop`、`turn_on/off` 等服务。

`Policy Gate` 负责在 simulator 前收窄本地权限，例如保护设备类型、数值范围、长耗时设备启动确认和 voice source 限制。Simulator 负责验证 provider service 是否支持；两者不能互相替代。

## 回归要求

每次修复真实设备 service 映射问题，都需要补：

- executor 单元测试。
- dry-run 验证。
- policy gate 边界测试，如适用。
- 如涉及真实 HA，必须先说明是否会实际控制设备。
