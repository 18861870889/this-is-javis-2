# Harness House Engineering Playbook

> 轻量吸收 Superpowers 的研发方法，但保持 Harness House 自己的产品约束：HCM-first、simulator-first、safety-gated real execution。

## 1. 工程目标

Harness House 的核心不是再做一个 Home Assistant 面板，而是建立一个可长期演进的 AI smart-home runtime：

- AI 理解自然语言和场景意图。
- HCM 描述房间、设备、能力、状态和策略。
- Adapter 只负责把 provider 原始世界映射到 HCM。
- Runtime 用确定性代码做校验、安全和执行。
- 真实设备控制必须经过 intent accuracy、safety gate、policy gate 和 service simulator。

## 2. 分层边界

```text
User / UI / 3D House
  -> Command Pipeline
  -> HCM Overlay + Personal Semantics
  -> Context Agent Snapshot
  -> LLM Planner
  -> Intent Accuracy Engine
  -> Safety Gate
  -> Policy Gate
  -> HA Service Simulator
  -> Device Runtime / Executor
  -> Provider Adapter
  -> HA / Matter / Mi Home / Other Providers
```

约束：

- UI 不直接依赖 HA entity。
- LLM 不直接选择 HA service。
- Adapter 不绕过 HCM policy。
- Policy Gate 不替代 Safety Gate，只能进一步收窄执行面。
- Digital Twin layer 只表达状态，不决定真实执行权限。
- 测试默认不控制真实设备。

## 3. 每次迭代的固定流程

1. Architecture Check

   明确改动属于哪一层：HCM、adapter、planner、intent accuracy、safety、policy、runtime、simulator、UI、learning。

2. Contract First

   如果涉及设备能力，先写 HCM 能力契约和测试样例。

3. Simulator First

   先在本地模拟层或 HA service simulator 验证，不直接操作真实设备。

4. Read-only Provider Verify

   读取 provider 当前状态、registry、service 能力和 supported features，确认映射事实。

5. Intent / Safety / Policy Gates

   真实执行前必须通过意图精度、capability、risk、confirmation、本地策略和 provider support 校验。

6. UI/3D Sync

   最后同步界面和 3D 房屋状态，避免 UI 先行制造错误假象。

7. Review + Push

   跑测试、构建、审查变更范围，然后提交并推送。

## 4. Debugging 规则

遇到 bug 时先找根因，不叠补丁。

最小流程：

- 复现问题，记录输入、输出、trace、状态快照。
- 沿链路定位问题发生层：planner、validator、safety、executor、adapter、provider。
- 找同类工作的正确样例。
- 写一个失败测试或 dry-run replay。
- 只改一个根因。
- 重新跑对应测试和回归。

如果连续三次修复都暴露新问题，停止继续打补丁，回到架构层重新判断当前设计是否错误。

## 5. TDD 使用边界

强制 TDD：

- 新 adapter。
- HCM schema / mapper。
- capability validation。
- intent accuracy rule。
- safety gate。
- policy gate。
- real execution service mapping。
- learning rule activation。

允许补测试后改造：

- 现有 UI 原型。
- 3D 可视化细节。
- 文档、样式、非关键展示逻辑。

## 6. 多 Agent 分工

多 agent 用于开发期和后台异步能力，不在 2 秒主链路里做长时间辩论。

建议角色：

| Agent | 职责 |
| --- | --- |
| Architecture Agent | 审查分层、HCM 范式和安全边界 |
| Adapter Agent | 实现 provider -> HCM 映射 |
| Simulator Agent | 构造 dry-run 和 service simulator |
| UI Agent | 维护 3D 房屋、review queue、状态展示 |
| Test Agent | 写 contract、回放、边界测试 |
| Review Agent | 查找越权、误控、耦合和回归风险 |

## 7. 项目铁律

- 真实设备不是默认测试环境。
- Provider 原始模型不能泄漏到上层控制逻辑。
- LLM 只生成意图计划，不拥有最终执行权。
- 安全策略由本地 deterministic runtime 判定。
- 意图、能力、安全、权限、service support 是五个不同 gate，不能合并成一个模糊判断。
- 每个 adapter 都必须能解释设备能力来源。
- 高风险、配置、隐私、燃气、门锁类能力默认禁止自动执行。
