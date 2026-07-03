# Harness House Test Cases

> 目标：验证“所有真实 HCM 指令先经过大模型意图解析，再由本地 HCM / safety / executor 生成精确控制指令”。

## 1. 测试原则

- 自动化测试默认不控制真实 Home Assistant 设备。
- LLM 输出只作为 draft；必须经过 HCM normalize、safety gate 和 executor 编译。
- 任何不存在的设备、未声明能力、只读 sensor、高风险/隐私/配置能力都不能执行。
- 状态查询必须先由 LLM 选中 HCM thing，再由本地读取状态，不能让模型编造状态。
- 控制指令必须输出确定性 provider service，例如 `media_player.media_pause`。
- 控制动作解析失败时必须返回 `needs_clarification` 或拒绝，不能降级成 `answered` 查询。

## 2. 场景级覆盖

| 用户输入 | 期望意图 | 目标 | 期望结果 |
| --- | --- | --- | --- |
| 玄关人体目前是什么状态 | `state_query` | 入户传感器 | 本地读取 HCM 状态并回答 |
| 小爱音箱停止播放音乐 | `device_control` | 小爱音箱Pro | 编译为 `media_player.media_pause` |
| 我要晾衣服 | `scene` | 阳台晾衣杆 | 编译为 `cover.set_cover_position(position=100)` |
| 准备看电影 | `scene` | 客厅电视/窗帘/灯 | 编译为电视开、窗帘位置、灯光亮度 |
| 主卧空调调到 26 度 | `device_control` | 主卧空调 | 编译为 `climate.set_temperature(26)` |
| 打开猫猫监控 | `device_control` | 猫猫监控 | 隐私能力阻断 |
| 打开燃气热水器 | `device_control` | 燃气热水器 | 高风险能力阻断 |
| 打开地下室灯 | `device_control` | 不存在设备 | 拒绝，不编造设备 |
| 让玄关人体变成有人 | `device_control` | 入户传感器 | sensor 只读，拒绝执行 |

## 3. 模型输出噪声

必须覆盖：

- 模型同时输出 `query` 和有效 `actions` 时，以 actions 作为控制计划。
- 模型输出 sensor capability 到 `actions` 时，normalize 阶段拒绝。
- 模型输出不存在的 `device_id` 或 `capability` 时，normalize 阶段拒绝。
- 模型 summary 可以使用，但执行依据只能来自 HCM ids。

## 4. Personal Semantics 与解释

必须覆盖：

- `晾衣服` 只能在明确匹配晾衣杆等目标时生成 planner hint，不能只凭房间把阳台开关当成候选。
- `玄关人体` 可以作为状态查询 hint 指向入户传感器。
- Personal semantics 只作为 LLM planner hints 和解释证据，不直接生成 executable actions。
- Intent explainer 必须输出目标设备、能力、service、家庭语义和安全判断。
- 状态查询解释必须明确“只读状态查询，不执行设备动作”。

## 5. Capability Compression 与反馈闭环

必须覆盖：

- 每个 HCM thing 会压缩出设备级能力边界：可自动、需确认、只读、保护、配置。
- 全屋能力摘要不暴露原始 HA entity 噪声，只显示可执行/确认/只读/保护的总量和设备面。
- Review Queue 能压缩成设备级 review surfaces。
- `no_action` / `rejected` / `partial_failure` 进入 shadow correction candidates。
- correction candidates 不会自动变成 personal semantics 或 executable actions。

## 6. HA Service Simulator 与调试安全

必须覆盖：

- `media_player` 支持 pause 时，停止播放编译并模拟为 `media_player.media_pause`。
- `media_player` 不支持 pause 但支持 stop 时，停止播放编译为 `media_player.media_stop`。
- `media_player` 明确不支持某个 service 时，模拟层拒绝，真实 executor 不下发。
- 设备离线时，模拟层拒绝并返回 `thing_offline`。
- service call 的 entity 不在当前 HCM snapshot 时，模拟层拒绝并返回 `unknown_entity`。
- dry-run 解释必须显示“模拟校验”，并明确未触碰真实设备。
- 自动化测试不能调用真实 `/api/services/*`；真实设备验收必须人工触发。

## 7. Multi-Agent Runtime

必须覆盖：

- Context Agent 从人在传感器判断书房有人，置信度高于 motion sensor。
- 玄关人体传感器只能作为 motion 证据，不能等同于长期人在。
- Mapping Agent 只能生成 shadow-mode 接入/边界建议，不能直接修改 overlay。
- Mapping Agent 必须同时读取 unresolved bindings 和 HCM capability policy。
- Learning Agent 只能整理 shadow learning candidates，`autoApply` 必须为 false。
- Diagnostics Agent 必须能发现近期 rejected / partial_failure / error。
- Diagnostics Agent 必须能发现 HA service simulator 拦截。
- Test Agent 必须生成 dry-run control、safety rejection、state query 三类建议用例。
- 单个 agent 抛错必须被隔离，不能阻断其它 agent snapshot。
- agent 超出预算必须标记 `timedOut`，不能直接影响主链路执行。
- 命令 audit 只保存 agent 摘要，不保存过大的完整 snapshot。
- UI Agents 面板展示 shadow 状态，不能提供直接执行按钮。

## 8. Provider-to-HCM Onboarding

必须覆盖：

- 新增明确低风险设备，例如灯具，生成 `allow_auto_candidate`。
- 新增高风险设备，例如燃气热水器，生成 `protect`。
- 新增隐私设备，例如摄像头，生成 `protect`。
- 新增配置/密码类 `text/select/number` 能力，生成 `protect` 或 review。
- 设备改名和换房间必须形成 diff，但不能丢失 entity identity。
- `supported_features` 变化必须形成 state/provider diff 和 HCM binding change。
- entity 删除后必须生成 `remove_from_planner`。
- Onboarding simulation 只能使用本地 simulator，不控制真实 HA 设备。
- API 层只能生成 proposal，不能自动写入 overlay 开放真实设备。

## 9. Intent Accuracy Engine

必须覆盖：

- 状态查询不能被当成控制指令拦截。
- 合理跨房间场景，例如“我要晾衣服”，不能因为人在其它房间而误拦截。
- 用户显式提到房间时，计划目标如果全部落在其它房间，必须要求确认。
- 模糊当前位置表达，例如“这边有点热”，必须参考 Context Agent 的 likely space。
- 低置信度执行必须产生可观察 issue，不能静默通过。

## 10. Home Digital Twin State Layers

必须覆盖：

- selection 和 occupancy 是不同 layer，不能互相覆盖。
- preview 只用于 dry-run 目标。
- execution 只用于非 dry-run 执行目标。
- alert 只能标记 diagnostics 中真实存在的设备。
- UI 渲染层不能把“选中房间高亮”等同于“人在房间”。

## 11. Policy & Permission System

必须覆盖：

- 低风险、策略范围内动作通过 policy gate。
- 温控、亮度、风扇、窗帘等数值超出本地策略范围时，在 HA simulator 前拦截。
- 摄像头、燃气/热水器等保护设备即使被错误 overlay 开放，也被 policy gate 拦截。
- 洗衣机、烘干机、扫地机器人等长耗时设备启动必须要求确认或被拦截。
- 自动化测试不能为了验证 policy 而调用真实 HA service。

## 12. Multi-Gang Switch Control Graph

必须覆盖：

- 二开面板必须生成两个独立 endpoint，不能只暴露父面板。
- 三开面板中的未使用按键必须保持 `unbound`，不能生成逻辑设备。
- 面板安装房间和灯具语义房间必须可以不同。
- 明确负载名称中的房间语义优先于物理面板 HA Area，不能因控制器安装位置不同而阻断。
- `绑定（设备）` 等远程入口必须保持独立 `remote_control/review`，不能替换直接继电器主执行器。
- `关闭餐厅射灯` 必须解析回对应单一 HA relay entity。
- `关闭餐厅所有灯` 必须枚举餐厅内可靠映射的逻辑灯具，不操作未绑定按键。
- `关闭书房射灯` 在没有书房映射时必须 no-action，不能匹配客厅或餐厅射灯。
- HA 互控、绑定、模式、童锁和其它配置 switch 不能进入 relay endpoint graph。
- 状态查询只能回答“控制回路开启/关闭”，没有独立证据时不能声称灯具真实发光。
- Digital Twin 生活视图显示逻辑灯具，preview/execution 使用逻辑 asset ID。
- 自动测试只能使用 fixture、当前只读快照和 dry-run，不调用 HA services。

核心实现和测试：

- `src/hcmControlGraph.js`
- `src/hcmControlGraph.test.js`
- `src/hcmPlanner.test.js`
- `src/houseSceneModel.test.js`
- `src/digitalTwinLayers.test.js`

## 13. Conversation, Group, Knowledge And Verification

必须覆盖：

- `餐厅射灯开着吗` 后输入 `关一下`，目标仍为餐厅射灯，不能被当前选中房间替换。
- `厨房灯开一下` 后输入 `不够亮啊`，必须优先继承厨房/上一轮目标所在房间，不能被历史书房偏好带跑。
- 会话目标和模型动作目标不一致时产生 `conversation_target_mismatch/critical`，不执行。
- `厨房有人不` 必须由厨房人在/presence sensor 回答，不能只返回空计划。
- `客厅有几个射灯` 返回 HCM 聚合数量和设备名，不回答某一盏灯的状态。
- `过道射灯关一下` 展开为射灯1和射灯2；任一主执行器未确认时整个集合不执行。
- `过道射灯还有一个没关` 只选择仍处于 `on` 的成员。
- 直接继电器与 `绑定（设备）` 远程入口分别建模，远程入口不能成为默认主执行器。
- 执行后调用 adapter `readState`；状态不收敛时不能标记 `executed`。
- `needs_clarification` 进入 shadow correction candidates，不能自动学习成可执行规则。

核心测试：

- `src/conversationContext.test.js`
- `src/hcmKnowledgeQuery.test.js`
- `src/hcmControlGraph.test.js`
- `src/providerExecutionRuntime.test.js`
- `src/intentAccuracyEngine.test.js`

## 14. Lighting Preference And Comfort

必须覆盖：

- `书房灯开着吗` 返回房间灯光聚合状态，例如射灯/吊灯分别开关，不把会话焦点固定到随机单灯。
- 房间级状态查询后的 `开一下` 继承上一轮房间焦点。
- `建议默认开射灯，如果我觉得还是暗了就再开一下吊灯` 进入 preference/shadow learning，不执行真实设备。
- `书房灯开一下` 这类模糊开灯优先选择 `射灯`，除非用户明确点名其他灯。
- `还是有点暗` 在同房间寻找仍关闭的其他灯并打开；不能重复打开已经开启的同一回路。
- 短体感反馈如 `不够亮啊`、`还是有点暗` 不能加载无关历史成功命令作为强 planner hint。
- 面向用户的回复使用自然语言短句，详细服务调用保留在 explanation/audit。

核心测试：

- `src/conversationContext.test.js`
- `src/hcmStateQuery.test.js`
- `src/hcmPlanner.test.js`
- `src/learningLayer.test.js`
- `src/intentExplainer.test.js`

## 15. Spatial Home Model Editor

必须覆盖：

- 空间编辑器不能把 HA Area 当成唯一真相；房间归属和地图坐标必须可分开维护。
- 逻辑资产和物理控制器必须分角色展示，不能把多键开关直接等同于它控制的灯。
- 已分配已放置、已分配待定位、已放置待归房、未拖入未分配四种设备状态必须稳定分类。
- 拖拽设备到房间区域时，必须同时产生 placement 和 room assignment。
- 拖拽设备到非房间地图区域时，必须保留 placement，并进入待归房状态。
- 清除地图定位不能删除房间归属。
- 取消归房不能删除地图定位。
- `房间 + 默认名` 和 `房间 + 自定义名` 两种命名模式必须可预测，不重复叠加房间前缀。
- 户型图上传和空间编辑状态保存到本地 Harness 服务文件，浏览器 local storage 只作为旧状态迁移和缓存；不能写 HA、不能写 overlay、不能执行 provider command。
- 自动化测试不能为了验证空间编辑而调用真实 HA services。

核心测试：

- `src/spatialHomeEditor.test.js`

## 16. Intent Frame, Grounding, Review And Learning Context

必须覆盖：

- 新版 `intent_frame` 必须能归一化为稳定的家庭语义契约，包括 goal、grounding、ambiguity、decision。
- 旧版 planner draft 仍必须兼容，不能因为新契约导致已有动作链路回退。
- Prompt Context Pack v2 必须按房间组织 affordances，并包含 occupancy、conversation、personal semantics 和 learning guidance。
- 模型输出 `target: "书房射灯"` 这类中文语义目标时，本地 resolver 必须落地到 HCM logical asset。
- 模型输出 `target: "射灯"` 且存在多个候选时，必须保留 ambiguity，不能静默选择。
- Grounding 诊断必须进入 plan/audit，至少包含 status、candidate count、explicit room 和 unresolved reason。
- Decision Review 必须在 provider simulation 之后、authorized execute 之前运行。
- unresolved control、empty control plan、policy rejected、simulation rejected 都不能进入 provider execute。
- read-only state/inventory/preference 计划不应因为没有 actions 被误拦。
- Household Learning Context 只能作为 planner guidance，`autoApply` 必须保持 false。
- 成功模式、偏好反馈、失败纠错都可以进入上下文，但都不能直接生成 executable actions。

核心测试：

- `src/intentFrame.test.js`
- `src/semanticGroundingResolver.test.js`
- `src/decisionReview.test.js`
- `src/hcmPlanner.test.js`
- `src/learningLayer.test.js`
- `src/commandRuntime.test.js`

## 17. 自动化测试入口

核心场景 benchmark 位于：

- `src/harnessScenario.fixture.js`
- `src/intentFrame.test.js`
- `src/semanticGroundingResolver.test.js`
- `src/decisionReview.test.js`
- `src/hcmIntentBenchmark.test.js`
- `src/intentAccuracyEngine.test.js`
- `src/hcmCapabilityCompression.test.js`
- `src/personalSemantics.test.js`
- `src/intentExplainer.test.js`
- `src/learningLayer.test.js`
- `src/homeAssistantServiceSimulator.test.js`
- `src/agentRuntime.test.js`
- `src/providerOnboarding.test.js`
- `src/digitalTwinLayers.test.js`
- `src/policyEngine.test.js`
- `src/spatialHomeEditor.test.js`

必须运行：

```bash
npm test
npm run build
```

## 18. v0.15-v0.23 验收与后续测试焦点

### v0.10 Real Home Pilot

- 真实设备测试必须人工授权。
- 只选低风险设备进入 pilot。
- 每次真实执行必须有 audit trace。
- HA 状态和 UI/3D 状态一致性需要抽样核对。
- 高风险、隐私、燃气、门锁、配置类能力保持 0 次自动执行。

### v0.15 Independent STT & TTS Alpha

- 按键录音得到的 transcript 必须在执行前对用户可见。
- STT transcript 必须进入与键盘输入相同的 `/api/hcm/command` 链路和 audit。
- 低置信度、空文本、音频截断和 provider 超时不能自动执行。
- STT 不能直接生成 service call 或绕过 Intent Accuracy / Safety / Policy Gate。
- TTS 只消费最终回复，不能朗读 LLM draft 或中间 plan。
- 页面重渲染或 audit 刷新不能导致同一结果重复朗读。
- 新消息打断旧消息后，旧消息不能继续恢复播放。
- TTS provider 超时或失败不能影响文字 UI、audit 和设备执行结果。
- TTS 播放期间 STT 必须暂停或忽略系统输出，防止回声形成新指令。
- TTS 输出不能作为新命令回流。
- 小爱、常开监听和唤醒词不在本版本测试范围。

当前 alpha 范围已由 `src/speechRuntime.test.js` 覆盖核心 provider、置信度、去重和失败降级逻辑。

### v0.16 Home Event & Automation Suggestions

- provider 事件只能生成 proposal，不能直接控制真实设备。
- 自动化 proposal 必须有触发条件、目标动作、风险说明和 dry-run 结果。
- 被用户拒绝或忽略的 proposal 不应反复打扰。

当前 shadow proposal 范围已由 `src/automationSuggestionEngine.test.js` 覆盖事件 diff、最小重复次数、失败审计过滤、本地模拟和 review decision。

### v0.17 Adapter SDK

- 新 provider 必须通过 raw graph -> HCM contract tests。
- provider-neutral snapshot diff 必须保留稳定 identity，并识别新增、删除、重命名、换房间和状态变化。
- provider unavailable 时，上层 UI 和 planner 必须得到明确错误或 simulator fallback。
- Contract Harness 不能调用 execute，也不能产生 Provider 外部副作用。
- Adapter execute 缺少 runtime authorization、成功 simulation 或 command ID 时必须拒绝。
- snapshot/evidence 中的 token、password、authorization 和 API key 必须被移除。
- Simulator 和 Home Assistant 必须通过同一 Contract `1.0`。
- 直连 Home Assistant action API 必须返回 `410`，真实控制只能进入 `/api/hcm/command`。

### v0.18A Multi-Gang Switch Control Graph

- 当前 HA snapshot 必须得到稳定 controller/endpoint/asset 数量。
- Mapping override 必须按 entity ID 持久化且不修改 provider 原始名称。
- Planner payload 不应暴露可直接猜测的多键面板 relay；应暴露逻辑设备 `power` 能力。
- normalize、executor、audit 和 digital twin 必须同时保留逻辑 asset 和 provider thing identity。
- 房间冲突必须在本地 normalize/accuracy 层发现，不能依赖 LLM 自觉修正。

### v0.18B Spatial Home Model Editor

- 设备空间编辑必须使用 HCM logical asset identity，而不是 provider 原始 entity 作为上层主键。
- 物理控制器可以被定位在安装房间，逻辑设备可以被定位在受控房间，两者不能互相覆盖。
- 本地空间编辑状态损坏时必须回退到空状态，不影响命令链路。
- 大尺寸户型图导致本地服务保存或浏览器缓存失败时，页面不能崩溃。

### v0.19 Assisted Mapping And 2D/3D Sync

- 已分配但未定位设备必须生成可解释定位建议，接受后进入已分配已放置。
- 已放置但未归房设备必须生成归房建议，接受后只更新本地空间状态。
- 地图位置房间和设备归属房间不一致时必须生成 review 建议，不能静默改写。
- 忽略过的空间建议不能反复出现在当前本地状态中。
- 2D 百分比坐标必须稳定投影为 3D scene 坐标，且不会修改 provider/HCM 原始设备对象。
- 房间自定义名称必须同步到 3D room label 和设备显示名。
- 2D/3D 同步只能影响可视化和本地空间模型，不能绕过 HCM、Intent Accuracy、Safety、Policy 或 Provider Adapter。

### v0.20-v0.23 Semantic Planner Architecture

- LLM 返回 `intent_frame` 但没有顶层 `actions` 时，系统仍能从 semantic decision actions 中归一化 HCM 动作。
- LLM 返回高歧义 frame 时，系统必须进入 clarification/review，而不是靠默认设备猜测。
- 用户纠错如 `你说错了吧` 必须作为 correction feedback，不执行设备、不自动改映射。
- Grounding resolver 只能生成 HCM 目标，不能生成 provider service。
- Decision Review 必须阻断 provider simulator 拒绝的计划。
- Learning context 必须进入 prompt context，但不能自动开放规则、写 overlay 或控制真实设备。
