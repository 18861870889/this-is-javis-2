# Harness House Roadmap

> 目标：把当前本地 3D 智能家居 MVP 演进成可接入真实设备、可理解设备能力边界、可安全执行、可持续自学习的开源 AI smart-home runtime。

工程执行方法见：

- [CURRENT_STATUS.md](CURRENT_STATUS.md)
- [ENGINEERING_PLAYBOOK.md](ENGINEERING_PLAYBOOK.md)
- [DEVICE_ADAPTER_CONTRACT.md](DEVICE_ADAPTER_CONTRACT.md)
- [TESTING_POLICY.md](TESTING_POLICY.md)
- [VERSION_WORKFLOW.md](VERSION_WORKFLOW.md)

## 1. 产品演进原则

Harness House 不应该直接变成“又一个 Home Assistant 面板”。它的核心价值是：

- 用自然语言表达意图。
- 把不同生态的设备归一成统一能力模型。
- 让 AI 只负责理解和规划，让 runtime 负责校验、安全和执行。
- 保持 2 秒内反馈的主链路。
- 把学习、总结、规则生成放到后台异步完成。

主链路约束：

```text
User Command
  -> Context Snapshot
  -> HCM Overlay + Personal Semantics
  -> Context Agent Snapshot
  -> Household Learning Context
  -> Prompt Compile
  -> Prompt Context Pack v2
  -> LLM Planner
  -> Intent Frame
  -> Semantic Grounding Resolver
  -> Plan Normalize
  -> Intent Accuracy Engine
  -> Safety Gate
  -> Policy Gate
  -> Provider Adapter Compile / Simulate
  -> Decision Review
  -> Authorized Provider Execute
  -> Audit / Learning / Agents
```

2 秒内返回的结果可以是：

- 已执行。
- 已下发。
- 需要确认。
- 失败原因。

不要求窗帘、晾衣杆、扫地机器人、洗衣机等长耗时设备在 2 秒内物理完成。

## 2. 版本节奏

### v0.1 - Local Simulator MVP

状态：已完成初版。

目标：

- 本地运行。
- 模拟智能家居设备接口。
- 3D 房屋实时反映设备状态。
- 支持真实 LLM JSON planning。
- 支持高风险确认。

已具备：

- React + Vite + Three.js 本地界面。
- 本地设备状态模拟。
- Fast Path 解析。
- LLM Gateway，兼容 OpenAI-style API。
- DeepSeek real mode。
- 3D 状态展示、拖拽旋转、基础设备动画。

验收：

- `npm run build` 通过。
- 本地页面可打开。
- 常见命令能在 2 秒左右返回。
- 高风险设备不会绕过确认。

### v0.2 - Device Manifest & Capability Runtime

目标：

把当前 `simulator.js` 里的设备数据升级为正式的 Harness Device Manifest。

新增能力：

- `DeviceManifest`：描述设备身份、房间、来源、状态、能力、风险。
- `CapabilityRegistry`：统一管理每个设备能做什么。
- `PlanValidator`：只允许 LLM 输出 manifest 中声明过的动作。
- `SimulatorAdapter`：当前本地模拟器成为第一个 adapter，而不是散落在业务逻辑里。

核心数据结构：

```json
{
  "id": "living_curtain",
  "name": "客厅窗帘",
  "roomId": "living",
  "type": "curtain",
  "source": "simulator",
  "capabilities": [
    {
      "name": "set_position",
      "valueType": "number",
      "min": 0,
      "max": 100,
      "unit": "%",
      "risk": "low",
      "confirmation": "never"
    }
  ],
  "state": {
    "position": 78,
    "online": true
  }
}
```

验收：

- LLM prompt 不再直接依赖散乱设备字段，而是依赖 capabilities。
- 未声明能力的动作会被拒绝。
- 越界值会被拦截，例如窗帘 `set_position=180`。
- 现有 demo 行为不回退。

测试要求：

- Manifest schema 单元测试。
- Capability range validation 测试。
- 高风险 confirmation 测试。
- 现有命令回归测试。

### v0.3 - Home Assistant Adapter Alpha

目标：

先接 Home Assistant，因为它覆盖设备生态最快，但 Harness House 不绑定死在 HA 上。

新增能力：

- HA REST / WebSocket 连接配置。
- HA entity discovery。
- HA entity -> Harness Device 映射。
- 基础 service 调用：
  - `light.turn_on/off`
  - `switch.turn_on/off`
  - `climate.set_temperature`
  - `cover.set_cover_position`
  - `fan.turn_on/off`
  - `media_player.turn_on/off`

关键设计：

```text
Home Assistant Entity
  -> Adapter Discovery
  -> Mapping Review
  -> Harness Device Manifest
  -> Capability Registry
  -> AI Planner
```

验收：

- 能连接一个本地 HA 实例。
- 能发现实体列表。
- 用户能把 HA entity 映射为房间和设备类型。
- 至少支持灯、窗帘、空调、风扇、开关五类真实设备。
- HA 不可用时，系统能回退到 simulator 或返回明确错误。

测试要求：

- HA API mock 测试。
- Adapter contract test。
- 网络失败、token 错误、entity missing 测试。
- 真实 HA 手工验收清单。

### v0.3.2 - Harness Capability Model & Provider Sync

状态：进行中。

目标：

不再让 AI、UI 和执行链路直接依赖 Home Assistant 的 entity 结构，而是定义 Harness House 自己的家庭能力模型：

```text
Provider Raw Graph
  -> Provider Adapter
  -> Harness Capability Model
  -> Policy Engine
  -> AI Planner / UI / Executor
```

核心原则：

- HA、Matter、米家、Tuya、Apple Home 都只是 provider。
- Harness House 的上层只消费 `Space -> Thing -> Capability -> State -> Action -> Policy`。
- provider 设备变动通过 snapshot hash + diff 被发现。
- 能自动判断的绑定直接进入 HCM。
- 语义不确定或高风险的绑定进入 `unresolvedBindings`。

新增能力：

- `HCM` schema。
- `ProviderSync` snapshot hash 和 HCM diff。
- Home Assistant device/entity/area registry 读取。
- HA registry + states -> HCM mapper。
- 真实设备目录 UI。
- 本地 HA 设备快照忽略规则，避免家庭设备明细误提交。

验收：

- 当前 HA 中 45 个 Xiaomi Home 物理设备会聚合成 HCM things，而不是暴露为 1600+ 个 AI 设备。
- `number/select/text/event` 默认不会自动执行。
- 开关面板中明确对应灯具的通道可被标成低风险候选能力。
- 配置、互控、密码、摄像头、燃气等能力默认阻断或需要确认。
- HCM endpoint 可被 UI 获取并展示真实设备统计。

### v0.3.3 - HCM Overlay & Review Decisions

状态：已完成初版。

目标：

让 Harness House 不只是被动展示 provider 的设备能力，而是开始拥有自己的家庭控制语义层。HA 里的实体变化可以持续同步，但用户对能力边界的判断会保存在 Harness 本地 overlay 中。

新增能力：

- `HCM Overlay`：本地持久化用户对 provider binding 的审核结果。
- Review Queue 操作：
  - 允许 AI 自动执行。
  - 执行前必须确认。
  - 禁止 AI 自动执行。
- 默认开放可执行能力：低/中风险控制和动作不再要求逐条点击。
- 建议调整清单：把高风险、敏感、配置、语义不清项聚合到设备级建议。
- `/api/hcm/overrides/bindings`：写入单条能力审核决策。
- `/api/hcm/overrides/default-run`：批量固化默认开放策略。
- `/api/hcm/home`：同步 HA 后自动套用 overlay，再重新计算 stats 和 review。
- UI 显示已审核数量，Review Queue 样本可直接操作。

设计收益：

- 更换 HA、Matter、米家、Tuya 等 provider 时，上层仍只认 HCM。
- provider 设备新增或变更后，Harness 重新同步；用户覆盖层继续作为家庭语义事实生效。
- AI prompt 和执行链路可以只接收已通过 HCM policy gate 的能力。

验收：

- `allow_auto` 会把对应 binding 转为低风险、免确认、可自动执行，并移出待确认队列。
- `require_confirmation` 会保留在待确认队列，强制执行前确认。
- `block` 会保留在待确认队列，并标为高风险禁止自动执行。
- 默认策略会自动开放可执行能力，但摄像头、燃气、配置/文本、敏感传感器会进入建议调整清单。
- overlay 文件为本地运行态文件，不提交到 GitHub。

### v0.4 - Mapping UI & Device Boundary Review

状态：已完成 alpha。

目标：

让用户清楚知道每个设备的能力边界，避免 AI “想当然”控制设备。

新增能力：

- 设备发现页面。
- 房间归属配置。
- 设备类型确认。
- 能力边界查看。
- 风险等级编辑。
- “允许 AI 自动执行 / 需要确认 / 永不自动执行”策略。
- HCM Prompt Compiler：只把已开放、低风险、免确认的真实能力暴露给 LLM。
- Real Device Execution Alpha：对话框优先走 HCM -> HA 的真实设备执行链路，失败时回退本地模拟。
- HCM policy gate：执行前再次校验能力、风险、确认策略和 HA domain。
- 设备边界最小操作：建议调整清单支持把设备隐藏出 AI 可控 HCM。

示例：

```text
switch.xiaomi_123
  用户确认：燃气热水器
  风险等级：high
  自动执行：禁止
  允许能力：turn_off
  turn_on：必须确认
```

验收：

- 未完成映射的实体不会进入 AI 可控设备列表。
- 用户可以把普通 switch 标记为高风险设备。
- LLM prompt 只包含已启用设备和已启用能力。
- UI 能清楚展示设备当前状态和可用动作。
- 真实执行只支持低风险自动能力，摄像头、燃气、配置/文本、敏感传感器不会下发。
- dry-run 可以验证自然语言 -> HCM plan -> HA service 的映射，不实际控制设备。

测试要求：

- 映射保存/读取测试。
- 风险策略测试。
- prompt 生成快照测试。
- 配置迁移测试。

### v0.5 - Production-grade Command Pipeline

状态：已完成。

目标：

把现在的命令执行链路拆成可测试、可观测的后端 pipeline。

新增模块：

- `CommandRouter`
- `ContextSnapshot`
- `LLMPlanner`
- `FastPathPlanner`
- `PlanValidator`
- `SafetyGate`
- `DeviceExecutor`
- `AuditLog`

链路输出必须结构化：

```json
{
  "commandId": "cmd_...",
  "path": "llm-real",
  "latencyMs": 1280,
  "status": "executed",
  "plan": [],
  "results": [],
  "safety": {
    "level": "low",
    "confirmationRequired": false
  }
}
```

验收：

- 每条指令都有 command id。
- 每一步有耗时记录。
- 每次 LLM 调用可以在本地 audit 中看到请求摘要和响应摘要。
- 失败可解释。
- 2 秒 SLA 可以被自动测试。
- `/api/hcm/command` 返回结构化 trace，包含 context、prompt compile、LLM、safety、executor 阶段。
- `/api/commands/audit` 可读取本地最近命令审计。
- `/api/commands/replay` 支持从 audit 中选择历史命令，以强制 dry-run 模式重新规划。
- trace 支持 `replayOf`，可以追溯 dry-run 回放来源。

测试要求：

- Pipeline integration tests。
- Latency budget tests。
- LLM timeout fallback tests。
- Audit log snapshot tests。

### v0.6 - Learning Layer Alpha

状态：已完成。

目标：

开始做 “越用越懂主人”，但不让学习逻辑直接改主链路。

新增能力：

- 用户纠错记录。
- 命令 -> 实际执行计划记忆。
- 场景偏好记忆。
- 异步 Evolution Worker。
- 规则候选生成，但默认需要用户确认后启用。

学习对象：

- 别名：`晾衣服 -> 阳台晾衣杆 set_position 100`
- 偏好：`睡觉 -> 主卧空调 25 度`
- 禁忌：`夜间不要打开客厅监控`
- 场景：`看电影 -> 客厅电视 + 灯光 + 窗帘`

验收：

- 学习结果不会自动越权执行。
- 用户可以查看、禁用、删除学习规则。
- 新规则上线前有 shadow mode。
- 学习不会影响高风险设备确认策略。
- `/api/learning/memory` 展示 shadow-mode 学习候选。
- UI 展示最近审计和学习候选，但不会自动写入 overlay。
- UI 支持忽略、删除学习候选。
- 删除候选会写入 tombstone，避免同一条历史观察立刻重新生成候选。
- 被忽略候选不会进入 top candidates，但保留在 memory 中供后续分析。

测试要求：

- Memory write/read tests。
- Shadow mode simulation。
- Preference conflict tests。
- Safety regression tests。

### v0.6.1 - HA Service Simulation & Debug Safety

目标：

把真实 HA 调试从“直接试设备”改成“读取真实接口，模拟 service 调用”，避免自动化测试误操作家庭设备。

新增能力：

- `HomeAssistantServiceSimulator`：基于当前 HA states、entity registry、device registry、supported_features 模拟 service 调用。
- HCM executor 的 service 选择优先参考 HA entity 能力，不只看 domain。
- `/api/hcm/command` 的调试默认使用 dry-run。
- 自动化调试禁止默认下发真实 `/api/services/*`。
- 只有用户明确授权时，才允许真实控制 HA 设备。

验收：

- `media_player` 的 pause/stop/play/turn_off 能根据 supported_features 做选择。
- 常见 domain 的 service 映射有 mock 覆盖。
- 自动化回归测试不依赖真实设备状态变化。
- 真实设备控制测试需要单独标记并人工确认。

### v0.7 - Intent Precision & Explainability

状态：已完成当前版本范围。

目标：

让所有真实 HCM 指令先经过大模型意图解析，再由本地 HCM、personal semantics、safety gate 和 executor 生成可解释、可审计的精确控制计划。

新增能力：

- LLM-first HCM intent resolution。
- Personal Semantics：把家庭语言作为 planner hints，例如 `晾衣服 -> 阳台晾衣杆`、`小爱音箱 -> 小爱音箱Pro`。
- Intent Dry-run Explainer：解释“我理解为、目标设备、执行能力、将调用 service、安全判断”。
- Capability Compression：把底层 capability 压缩为设备级边界摘要：可自动、需确认、只读、保护/配置。
- 场景级 benchmark：覆盖状态查询、单设备控制、场景意图、越权拒绝、模型噪声。
- Correction Feedback Loop：`no_action`、`rejected`、`partial_failure` 会生成 shadow correction candidates，不自动执行。

验收：

- 状态查询不绕过 LLM，但状态内容由本地 HCM 读取。
- Personal semantics 不直接执行，只影响 planner hints 和解释证据。
- Sensor/config/privacy/gas 等能力不能被模型放进 executable actions。
- 每条真实 HCM 结果都能解释目标、能力、service 和安全原因。
- Home Model 面板能展示设备级能力边界，Review Queue 以设备级建议为主。
- 纠错候选只提示补充语义或映射，不会绕过安全门。
- `npm test` 覆盖家庭场景 benchmark，错误执行率保持 0。

### v0.8 - HA Service Simulation & Debug Safety

状态：已完成 alpha。

目标：

把真实 HA 调试从“直接试设备”改成“读取真实接口，模拟 service 调用”，避免自动化测试误操作家庭设备。

新增能力：

- `HomeAssistantServiceSupport`：集中维护 HA domain service 白名单和 `media_player.supported_features` 判断。
- `HomeAssistantServiceSimulator`：基于当前 HCM snapshot、HA entity binding、online 状态和 `supported_features` 模拟 service 调用。
- HCM executor 的 `media_player` service 选择优先参考 HA entity 能力，不只看 domain：
  - 停止播放优先 `media_pause`。
  - 不支持 pause 但支持 stop 时使用 `media_stop`。
  - 不支持 pause/stop 但支持 turn_off 时使用 `turn_off`。
- `/api/hcm/command` 在 safety gate 后新增 `ha_service_simulator` 阶段。
- simulator 拒绝 unknown entity、offline thing、domain mismatch、unsupported service、unsupported media feature。
- dry-run/explainer 会展示模拟校验结果；自动化调试不会触碰真实设备。

验收：

- `media_player` 的 pause/stop/play/turn_off 能根据 supported_features 做选择。已覆盖。
- 常见 domain 的 service 映射有 mock 覆盖。已覆盖基础白名单。
- 自动化回归测试不依赖真实设备状态变化。已覆盖。
- 真实设备控制测试需要单独标记并人工确认。继续作为工程政策。
- 当模拟层拒绝 service call 时，真实 executor 不会被调用。

### v0.9 - Multi-Agent Runtime

状态：已完成。

目标：

引入多 agent，但只用于提升可靠性和可维护性，不在主链路里做长时间争论。

建议 agent 分工：

| Agent | 职责 | 是否在主链路 |
| --- | --- | --- |
| Intent Agent | 解析自然语言，生成候选计划 | 是，最多一次 LLM |
| Safety Agent | 审查风险、权限、确认策略 | 是，本地优先 |
| Device Agent | 根据 manifest 执行设备动作 | 是 |
| Context Agent | 维护房间、人在、时间、设备快照 | 否，异步更新快照 |
| Learning Agent | 从日志中总结偏好和规则 | 否，异步 |
| Diagnostics Agent | 检查失败、离线、延迟异常 | 否，异步 |
| Test Agent | 自动生成回归用例和仿真场景 | 否，开发期 |

当前完成范围：

- `AgentRuntime`：统一生成 shadow-mode agent snapshot，不写 overlay、不执行设备。
- 每个后台 agent 独立执行，记录 `latencyMs` / `budgetMs` / `timedOut`，异常会被隔离成单个 agent error，不阻断其它 agent。
- `Context Agent`：从 HCM presence / motion / door sensor 推断房间占用置信度。
- `Learning Agent`：读取 learning memory 和近期 audit，整理 shadow learning candidates，不自动应用规则。
- `Mapping Agent`：基于 unresolved bindings 与高风险/非自动 capability 生成接入和边界建议。
- `Diagnostics Agent`：从 HCM 和最近 audit 中发现离线设备、失败指令、service simulator 拦截和 2 秒预算问题。
- `Test Agent`：基于当前 HCM 自动生成 dry-run control、safety rejection、state query 回归测试建议。
- `/api/agents/snapshot`：读取当前后台 agent 快照。
- `/api/hcm/command` 返回与 audit 中附带 agent 摘要，但 agent 不参与主链路执行决策。
- UI `Agents` 面板展示 context / learning / mapping / diagnostics / test 的 shadow 建议。

主链路不做 agent debate。可接受的模式是：

```text
Intent Agent 生成 plan
Safety Agent 本地校验
Device Agent 执行
Learning/Diagnostics 后台观察
```

验收：

- 多 agent 失败不会阻塞基础控制。已通过旁路 snapshot 设计约束。
- Learning / Mapping Agent 只生成建议，不直接改生产规则。已覆盖。
- Diagnostics Agent 能发现失败、离线、service simulator 拦截、响应慢。已覆盖。
- Test Agent 能基于设备 manifest 生成命令测试集。已覆盖。

测试要求：

- Agent contract tests。已覆盖。
- Agent timeout tests。已覆盖预算标记。
- Background worker retry tests。当前实现为同步 shadow snapshot，worker 化后再扩展重试队列。
- Generated test case review。已覆盖 Test Agent 用例生成。

### v0.10 - Real Home Pilot

目标：

在真实住宅里小范围试运行。

范围建议：

- 先接低风险设备：
  - 灯
  - 风扇
  - 窗帘
  - 电视
  - 空调温度
- 暂缓自动控制：
  - 燃气热水器
  - 摄像头隐私
  - 门锁类设备
  - 洗衣机/烘干机启动

验收：

- 连续运行 7 天。
- 常见命令 P95 小于 2 秒返回。
- 真实设备状态与 UI 状态一致率高于 98%。
- 高风险动作 0 次误执行。
- 所有失败都有 audit log。

测试要求：

- 每日 smoke test。
- HA reconnect test。
- 断网/断电恢复测试。
- 实体重命名/删除测试。

### v0.11 - Provider-to-HCM Onboarding & Adapter Abstraction

状态：已完成。按当前研发节奏先于 v0.10 实现。

目标：

当新设备先接入 Home Assistant 或其它 provider 后，Harness House 可以自动/半自动把 provider 原始设备靠近 HCM 范式，而不是每新增一种设备都改代码。

主流程：

```text
Provider Snapshot A
  -> Provider Snapshot B
  -> Provider Diff
  -> HCM Mapping
  -> Onboarding Candidate
  -> Safety Classification
  -> Service Simulation Probe
  -> Overlay Proposal
  -> User Review
```

新增能力：

- `diffProviderGraphs`：检测 provider device/entity/area/state 的新增、删除、变更。
- `planProviderOnboarding`：基于 previous graph、next graph 和 HCM 生成接入计划。
- 新增设备候选分类：
  - `allow_auto_candidate`
  - `review`
  - `protect`
  - `read_only`
- 新增低风险明确设备可以生成自动开放候选。
- 高风险、隐私、配置、语义不清设备默认 protect/review。
- Entity 删除会生成 `remove_from_planner`，防止 LLM 继续使用不存在能力。
- supported_features 变化会进入 provider diff 和 HCM binding changed。
- Onboarding simulation probe 只调用本地 HA Service Simulator，不控制真实设备。
- `/api/onboarding/plan`：读取当前 HA graph，和 baseline 比较后返回接入计划。
- `/api/onboarding/snapshot`：记录当前 HA graph 为 provider baseline。
- Home Model 面板展示 Onboarding 摘要和候选样本。

验收：

- 不需要真实新增设备，也能用 mock provider graph 覆盖新增设备流程。已覆盖。
- 新增明确灯具可生成 `allow_auto_candidate`。已覆盖。
- 新增燃气、摄像头、密码/配置类能力默认 `protect`。已覆盖。
- 设备改名/换房间不会丢失 entity identity。已覆盖。
- supported_features 变化会触发能力边界更新。已覆盖。
- entity 删除后生成移除计划，不再暴露给 planner。已覆盖。
- 所有 onboarding 测试不控制真实 HA。已覆盖。

测试要求：

- Provider graph diff tests。
- Onboarding planner tests。
- Risk classification tests。
- Simulation probe tests。
- Rename/move/remove regression tests。

### v0.12 - Intent Accuracy Engine

状态：已完成。跳过 v0.10 pilot 后先实现本地意图精度 gate。

目标：

所有真实 HCM 指令继续先经过大模型，但模型输出必须再经过本地意图精度评估，避免“模型选错房间/设备”直接进入执行链路。

新增能力：

- `evaluateIntentAccuracy`：评估显式房间、人在位置、模糊表达、动作目标和模型置信度。
- `applyIntentAccuracyGate`：明显房间错配或上下文错配时，把计划转为需要确认。
- `context_agent` 前置到真实命令主链路，给 planner 和意图评估提供只读人在位置上下文。
- LLM prompt payload 增加 compact context，但最终 gate 由本地 deterministic runtime 判定。

验收：

- 状态查询不被误判成控制动作。已覆盖。
- “我要晾衣服”这类合理跨房间场景不会被人在书房误拦截。已覆盖。
- 明确说主卧却计划到客厅会要求确认。已覆盖。
- “这边有点热”在书房有人时计划主卧空调会要求确认。已覆盖。
- 低置信度执行会进入可观察 review 信号。已覆盖。

### v0.13 - Home Digital Twin State Layers

状态：已完成。

目标：

3D 房屋不再用单一高亮表达所有状态，而是拆成可组合状态层，避免“选中房间”和“人在房间”语义混淆。

新增能力：

- `buildDigitalTwinLayers`：生成 `selection / occupancy / execution / alert / preview` 五类状态层。
- `applyDigitalTwinLayersToScene`：把 layer 合并到 scene rooms/devices。
- `ThreeHouse` 根据 layer 渲染不同房间环和设备环。
- dry-run 目标进入 preview，真实执行目标进入 execution，诊断 target 进入 alert。

验收：

- selection 与 occupancy 可以同时存在且互不覆盖。已覆盖。
- dry-run 与真实执行目标使用不同 layer。已覆盖。
- diagnostics 只标记真实存在的设备，不发明设备点。已覆盖。

### v0.14 - Policy & Permission System

状态：已完成当前 runtime gate 版本。

目标：

Safety Gate 之后增加本地策略层，收窄“能执行”和“此刻应该执行”的边界，为后续语音入口、时间窗、用户权限和真实家庭 pilot 做准备。

新增能力：

- `evaluateExecutionPolicy`：对 Safety Gate accepted actions 进行二次策略判定。
- `policy_gate` 接入 `/api/hcm/command`，位于 `safety_gate` 和 `ha_service_simulator` 之间。
- 当前策略覆盖：
  - 保护设备类型兜底：摄像头、燃气/热水器即使错误开放也会拦截。
  - 数值范围：空调 16-30，窗帘/灯/风扇 0-100。
  - 长耗时设备启动：洗衣机、烘干机、扫地机器人启动需要确认。
  - 语音入口预留：voice source 禁止配置能力。

验收：

- 低风险、范围内动作可以通过。已覆盖。
- 超出策略范围的数值在 HA simulator 前被拦截。已覆盖。
- 错误 overlay 导致保护设备变成可执行时，policy gate 仍会拦截。已覆盖。
- 长耗时设备启动不会静默自动执行。已覆盖。

### v0.15 - Independent STT & TTS Alpha

状态：已完成 alpha 范围。

目标：

实现独立 STT + TTS 语音交互，不接小爱。采用按键录音和半双工模式：用户讲话时录音，STT 生成可见文本，文本进入现有 HCM command pipeline，最终结果再由 TTS 朗读。

建议范围：

- 新增 `SpeechInput` 抽象：麦克风音频 -> STT provider -> transcript/confidence。
- STT 结果先显示为文字，再提交 `/api/hcm/command`；STT 不直接生成 HCM action 或调用设备。
- 低置信度、空文本、截断音频必须提示重试或人工修正，不能静默执行。
- 新增 `SpeechOutput` 抽象，业务层只提交待朗读文本，不依赖具体 TTS provider。
- TTS 消费最终 audit response，不消费 LLM draft 或中间 plan。
- 默认半双工：TTS 播放期间暂停 STT，防止系统把自己的声音识别为新指令。
- 支持开关、音量、停止/打断、重复消息抑制和长文本截断。
- 状态查询、执行成功、拒绝、需要确认使用不同的简短朗读模板。
- STT/TTS provider 失败不能影响文字输入、文字结果和设备执行链路。

非目标：

- 小爱音箱接入。
- 生产级常开监听。
- 唤醒词检测。
- 不展示转写文本就直接执行的“黑盒语音控制”。

验收：

- 按键录音可以生成可见 transcript 和置信度。
- 正常 transcript 进入与键盘输入相同的 HCM command pipeline 和 audit。
- 低置信度、空文本和音频截断不会自动执行。
- 状态查询和执行结果可以被朗读。
- 同一结果只朗读一次，页面重渲染不会重复播放。
- 新消息可以按策略打断旧消息。
- TTS 播放期间 STT 不采集系统输出。
- STT/TTS 失败时文字 UI、audit 和设备执行结果不受影响。
- TTS 输出不能被系统当成新指令回流。

### v0.16 - Home Event & Automation Suggestions

状态：已完成 shadow proposal 范围。

目标：

让系统开始观察“人在、门窗、设备状态、时间”这些家庭事件，并从重复行为中提出自动化建议。第一阶段只做建议、模拟和审核，不直接写 HA 自动化，也不自动执行新规则。

示例：系统发现“晚上 20:00 后书房有人时，主人通常会在 30 秒内开灯”，于是建议“晚上书房有人时打开书房灯”。用户可以查看触发条件、目标设备、风险和模拟结果，再决定是否采用。

建议范围：

- 通过只读 API 采集当前 HCM 状态快照并生成变化事件。已完成。
- 至少两次相似成功 audit action 才生成候选自动化。已完成。
- 用 HCM Executor、Policy Gate 和 HA Service Simulator 做 automation preview。已完成。
- 用户可以标记 reviewed / ignored；当前不写 overlay 或 provider automation。已完成。

验收：

- 事件输入不会直接控制真实设备。
- 自动化 proposal 有触发条件、目标动作、安全解释和回滚方式。
- 可用 dry-run replay 验证 proposal。

### v0.16.1 - Morning Mint UI Refresh

状态：已完成。

目标：

在不改变命令链路和设备控制边界的前提下，把深色工程 Demo 升级为更清新、适合长期家庭使用的操作界面。

完成范围：

- 全局视觉令牌切换为暖白、薄荷绿、浅灰绿、琥珀和珊瑚红。
- 左右操作轨道、命令、Agent、设备映射、自动化、传感器和审计面板统一浅色表面层。
- Three.js 场景更新房间地面、墙体、家具、灯光、雾、网格和标签材质。
- 保持 `selection / occupancy / preview / execution / alert` 五类状态的独立视觉语义。
- 修复 Command 输入区与后续面板重叠，并压缩移动端无效对话空白。
- 完成桌面与 390px 手机布局检查，无横向溢出。

非目标：

- 不改变 HCM、LLM Planner、Safety Gate、Policy Gate 或真实设备执行逻辑。
- 不在本版本重构信息架构或增加新的设备功能。

### v0.17 - Adapter SDK & Provider Portability

状态：已完成 SDK 与现有 Provider 迁移范围。

目标：

把“承载终端里的设备如何变成 HCM 能力”做成标准接口和测试工具。这样未来不用 HA、改用 Matter/MQTT，或者接入其它 provider 时，只需要实现新的 adapter；LLM planner、安全策略、Policy Gate、audit 和 3D UI 不需要重写。

示例：当前 `light.living_room -> HA Adapter -> HCM light`；未来 `Matter light -> Matter Adapter -> 同一个 HCM light`。上层只看到相同的开关/亮度能力。

建议范围：

- Adapter contract test harness。已完成。
- Provider snapshot fixture 格式。已完成。
- Capability evidence schema。已完成。
- Provider-neutral snapshot diff。已完成。
- Provider registry。已完成。
- Simulator provider adapter template。已完成。
- Home Assistant Adapter 迁移。已完成。
- 真实执行的 simulation / authorization / commandId gate。已完成。

验收：

- 新 provider 可以用 mock graph 通过 contract tests。已覆盖。
- Provider 变更能通过稳定 identity 生成 provider-neutral diff。已覆盖。
- Adapter 必须输出 HCM，planner/UI 不读取 provider raw graph。已覆盖。
- Contract Harness 不调用 `execute()`，自动化测试不会控制真实设备。已覆盖。
- 公开直连 HA action 路由被禁用，真实执行只能走完整 HCM 命令链。已覆盖。

边界：

- Matter/MQTT 尚无真实设备认证；当前完成的是 SDK、模板、fixture 和可替换运行边界。
- 新 Provider 仍需实现自身的 raw snapshot -> HCM mapper 和 provider command compiler，但不需要修改 Planner、Policy、Audit 或 3D UI。

### v0.18A - Multi-Gang Switch Control Graph

状态：已完成核心模型、规划器集成、API、生活视图投影和自动化验证。

目标：

把 HA 的“设备优先”目录转换为居民可理解的受控对象，同时保留稳定 provider identity 和完整安全链路。

完成范围：

- `Controller / Endpoint / Asset / Space` 控制图。
- 二开、三开面板的独立继电器提取。
- 配置项、互控、绑定和模式实体从 relay graph 排除。
- 逻辑灯具房间与物理面板安装位置分离。
- `bound / review / unbound / ignored` 映射状态。
- HCM Overlay 控制映射和本地 API。
- Planner 只面向可靠逻辑灯具，normalize 回落到物理 capability。
- 显式房间冲突硬拒绝。
- 继电器 commanded state 与真实 observed state 分离。
- 3D/房间列表生活视图使用逻辑资产。

当前真实快照验证：

- 22 个开关面板。
- 56 个继电器端点。
- 41 个逻辑受控对象。
- 入户1号开关左键正确映射餐厅射灯，右键正确映射餐边柜灯带。
- `关闭餐厅所有灯` dry-run 只生成上述两个 `switch.turn_off`。

### v0.18.1 - Intent And Control Closed Loop

状态：已完成。

目标：让自然语言理解、逻辑设备、provider 执行和数字孪生反馈形成可审计闭环。

完成范围：

- 会话目标记忆和省略指令漂移拦截。
- 控制请求不可降级为状态查询成功。
- HCM inventory/count/list 聚合查询。
- 编号设备集合原子展开和残差成员选择。
- 直接继电器主执行器与远程绑定关系分离。
- provider execute 后状态回读和收敛判定。
- `needs_clarification` shadow correction learning。
- 根据显式房间/会话目标缩小 LLM 设备上下文。

真实快照 dry-run 验证：

- `客厅有几个射灯` 返回 2 个目标且不生成 service。
- `过道射灯关一下` 生成射灯1/2两个独立 `switch.turn_off`。
- `关闭过道射灯2` 选择入户四号开关右键直接继电器。
- `过道射灯还有一个没关` 只选择仍为 `on` 的射灯2。
- 查询餐厅射灯后输入 `关一下`，即使 UI 选中书房，目标仍保持餐厅射灯。

### v0.18B - Spatial Home Model Editor

状态：已完成本地编辑器范围。

目标：

- 上传户型图并绘制/校正房间区域。
- 分开管理房间归属和地图坐标。
- 支持已分配已放置、已分配待定位、已放置待归房、未整理四种状态。
- 在生活视图放置逻辑资产，在维护视图放置物理控制器。
- 点击逻辑设备定位并展示受控房间、控制器、通道、HA entity 和能力边界。
- 2D 空间数据作为 3D scene 的来源，但不成为意图控制的硬依赖。

当前完成范围：

- 左侧空间编辑器面板。
- 户型图上传并保存在本地 Harness 服务文件；浏览器 local storage 仅作为旧状态迁移和缓存。
- 房间名称本地覆盖。
- 设备拖拽到地图和房间区域。
- 设备状态分组：已分配已放置、已分配待定位、已放置待归房、未拖入未分配。
- 逻辑资产与物理控制器分角色展示。
- 设备命名模式：房间 + 默认名、房间 + 自定义名。
- 点击设备查看详情并定位地图标记。

边界：

- 当前不写 Home Assistant、不写 HCM Overlay、不调用真实设备。
- v0.19 已补齐本地 2D 空间编辑结果到 3D scene 的投影。

### v0.19 - Assisted Mapping And 2D/3D Sync

状态：已完成本地建议与 3D 同步范围。

目标：

- 根据 HA Area、实体命名和控制图生成设备归房建议。
- 2D 编辑结果同步到 3D 数字孪生。
- Provider 更换或实体变化时通过稳定 identity 重新绑定，不重建房屋语义模型。

当前完成范围：

- 对已分配但未定位设备生成定位建议。
- 对已放置但未归房设备生成归房建议。
- 对地图位置和房间归属冲突生成检查建议。
- 建议可以本地接受或忽略，不写 provider、不写 overlay。
- 接受建议后，房间名、设备归属和 2D 地图坐标会投影到 3D scene model。
- 3D 数字孪生在 digital twin layers 前消费空间投影，因此 selection / occupancy / preview / execution / alert 仍然正常叠加。

后续增强：

- 户型区域自动识别和手工边界校正。
- 真实 provider identity 迁移后的空间状态再绑定测试。
- 物理控制器维护视图与生活视图切换。

### v0.20 - Intent Frame & Prompt Context Pack v2

状态：已完成。

目标：

- 让 LLM 先表达家庭语义层理解，而不是直接从自然语言跳到底层动作 JSON。
- 把 prompt 从扁平设备表升级成房间化、能力化、上下文化的 Prompt Context Pack。
- 保持旧版 `actions` 输出兼容，降低模型契约迁移风险。

完成范围：

- `Intent Frame`：包含 intent type、goal、required facts、candidate targets、ambiguity、decision mode 和 HCM-level actions。
- `Prompt Context Pack v2`：包含空间、房间 affordances、人在状态、会话焦点、personal semantics 和 learning context。
- HCM planner prompt 要求模型只输出 HCM 语义动作，不输出 provider service。
- Command audit 摘要记录 intent frame。

验收：

- 新版 `intent_frame` 可以被归一化。
- 旧版 planner draft 仍可通过现有测试。
- Context pack 按房间组织能力，而不是只暴露扁平设备列表。

### v0.21 - Semantic Grounding Resolver

状态：已完成。

目标：

- 让模型可以说“书房射灯”这类家庭语义目标，由 Harness 本地落地到 HCM logical asset。
- 多候选时保留 ambiguity，不静默猜测。

完成范围：

- `SemanticGroundingResolver` 支持 HCM thing、logical asset、房间约束和别名匹配。
- `normalizeSemanticPlannerActions` 在 action validation 前把语义目标补成 HCM ID。
- 每个 plan 附带 grounding 状态、候选目标、显式房间和 unresolved reason。

验收：

- `target: "书房射灯"` 可解析为 `asset_study_书房射灯`。
- `target: "射灯"` 多候选时保持 ambiguity，不直接执行。
- 现有 HCM planner 行为不回退。

### v0.22 - Decision Review & Recovery

状态：已完成。

目标：

- 在 Safety / Policy / Provider Simulation 之后增加本地复核，避免“不完整计划”或“模拟拒绝计划”进入执行。
- 给用户和 audit 一个更可读的失败恢复原因。

完成范围：

- `decision_review` 接入 `/api/hcm/command`，位于 provider simulation 之后、authorized execute 之前。
- 阻断 unresolved control、empty control plan、safety rejection、policy rejection、simulation rejection。
- 生成 recovery mode：`ask_clarification`、`adapter_diagnosis`、`safety_review`。
- Explainer 使用 decision review recovery message 生成更自然的失败回复。

验收：

- read-only 查询不要求动作。
- provider simulation 拒绝时不会执行。
- unresolved 控制进入 clarification/review。

### v0.23 - Household Learning Context

状态：已完成。

目标：

- 把 shadow learning 作为模型上下文，而不是自动规则变更。
- 让模型能参考用户偏好和历史失败模式，同时仍受 HCM grounding 和安全门约束。

完成范围：

- `compileHouseholdLearningContext` 把成功模式、偏好候选、失败纠错候选转成 planner guidance。
- Learning context 被写入 Prompt Context Pack v2 和 HCM LLM payload。
- `autoApply=false` 明确保留，学习不能自动创建动作。

验收：

- 相似成功命令生成 planner hint。
- 失败命令生成 correction hint。
- 学习上下文不能绕过 HCM normalize、Safety、Policy、Simulation、Decision Review。

### v0.25 - Conversation Router

状态：未来计划，暂缓实现。

目标：

- 在 HCM 之前增加轻量入口路由，避免把所有用户话语都强行解释成智能家居设备控制。
- 把“家庭 AI”和“设备执行器”分层：HCM 继续负责家居控制和家居状态，Router 负责识别请求类型。

拟定范围：

- 本地确定性问题：`现在几点了`、`今天几号` 直接由本地回答。
- 普通对话/故事：`讲个睡前故事` 进入 chat/TTS 路径，不进入 HCM 执行链。
- 外部知识：`世界杯什么时候开始` 进入未来 external knowledge provider，或明确提示需要联网查询。
- 设备能力查询：`电视有哪些可控制功能` 进入 HCM read-only capability lookup。
- 家居控制/状态/场景：继续进入当前 LLM Planner -> Intent Frame -> HCM pipeline。

设计约束：

- 不增加额外一次 LLM 调用；优先使用本地高置信规则和现有 intent frame。
- 规则只做入口分流，不生成设备动作。
- 低置信或复杂场景仍交给模型和 HCM，而不是靠关键词硬猜。
- 每条规则必须有误伤测试和 audit reason。

暂缓原因：

- 当前先保持 v0.24 Runtime Gate 稳定，不扩大入口行为面。
- 该能力需要成体系测试非家居请求、能力查询和家居场景的边界，避免把简单规则写成难维护的 if-else。

### v1.0 - Open Source AI Smart Home Framework

目标：

作为开源项目对外发布第一版稳定框架。

必须具备：

- Device Manifest 标准。
- Simulator Adapter。
- Home Assistant Adapter。
- Capability Registry。
- Intent Accuracy Engine。
- Safety Gate。
- Policy Gate。
- HA Service Simulator。
- LLM Planner。
- Fast Path。
- Audit Log。
- Mapping UI。
- 基础 Learning Layer。
- Provider-to-HCM Onboarding。
- Digital Twin State Layers。
- 完整开发文档。

v1.0 不追求：

- 支持所有品牌原生云。
- 完全自动自进化。
- 复杂多用户权限。
- 全屋无人值守自动控制。

## 3. 测试策略

### 3.1 测试金字塔

```text
Unit Tests
  Manifest schema
  Capability validation
  Risk policy
  Plan validation
  Device state reducer

Integration Tests
  Command pipeline
  LLM timeout fallback
  HA adapter mock
  Simulator adapter

E2E Tests
  Browser command input
  3D state reflection
  Confirmation flow
  Mapping UI

Pilot Tests
  Real HA instance
  Real low-risk devices
  Failure recovery
```

### 3.2 必测场景

低风险：

- `关客厅灯`
- `打开书房风扇`
- `客厅窗帘关上`
- `厨房有点闷`

中风险：

- `我要洗衣服`
- `启动扫地机器人`
- `我要晾衣服`

高风险：

- `打开燃气热水器`
- `关闭监控隐私模式`

模糊指令：

- `有点热`
- `太亮了`
- `我要睡了`
- `准备看电影`

异常：

- 设备离线。
- entity 不存在。
- LLM 超时。
- adapter 返回失败。
- 状态回读不一致。

### 3.3 自动化测试门禁

每个 PR 至少通过：

```bash
npm test
npm run build
git diff --check
```

如果接入真实设备 adapter 或真实 pilot，需要额外执行人工授权的只读/真实设备验收清单。当前仓库提供 `test:adapter`，暂未提供 `test:e2e` npm script。

当前自动化测试已覆盖 HCM planner/executor、intent frame、semantic grounding、decision review、household learning context、HA service simulator、multi-agent runtime、provider onboarding、intent accuracy、digital twin layers、policy gate 和 Adapter Contract。Adapter 专项测试可运行 `npm run test:adapter`。浏览器/Playwright 类 E2E 后续作为 v1.0 前质量补强。

## 4. 多 Agent 开发协作

多 agent 不只是产品能力，也可以用于开发流程。

建议开发期 agent 分工：

| Agent | 产物 |
| --- | --- |
| Architecture Agent | manifest、pipeline、adapter contract 设计 |
| Runtime Agent | DeviceRuntime、CapabilityRegistry、Executor |
| Adapter Agent | HA/MQTT/Matter adapter |
| Frontend Agent | Mapping UI、3D 状态、操作台 |
| Test Agent | 单测、集成测试、E2E 测试 |
| Safety Agent | 风险等级、确认策略、权限边界 |
| Docs Agent | README、PRD、adapter 开发文档 |

每个 agent 的输出都要经过同一套门禁：

- 是否符合 HCM / provider adapter contract。
- 是否有测试。
- 是否不泄露 key。
- 是否不绕过 Intent Accuracy、Safety Gate、Policy Gate 和 Service Simulator。
- 是否保持 2 秒主链路目标。

## 5. 近期实施建议

当前工程基线是 `v0.24`。下一步不要继续扩大真实执行面，先按下面顺序推进：

1. `v0.10 Real Home Pilot`：只选低风险设备，人工授权真实执行，连续观察稳定性和状态一致性。
2. `v0.25 Conversation Router`：作为未来计划保留，暂不实现；等 v0.24 安全边界和能力查询回归更稳定后再进入开发。
3. `v1.0`：补齐 E2E、发布包和开源发布流程，并在有条件时增加 Matter/MQTT 实机认证。

近期不建议做：

- 绕过 HCM 直接调用 HA service。
- 让 learning/agent 自动写生产规则。
- 为单个米家实体写硬编码特殊逻辑。
- 在没有审计和 dry-run 的情况下扩大真实设备控制范围。
