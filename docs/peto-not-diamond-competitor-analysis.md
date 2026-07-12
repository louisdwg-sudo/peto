# PETO vs Not Diamond

Competitor case study, market review, and positioning recommendation.

Prepared: 2026-07-05

## English Version

### Executive Take

Not Diamond is a broader model-routing decision layer for coding agents. PETO is narrower and more specific: an effort and tokenomics optimizer that keeps the executor model fixed and chooses reasoning effort to minimize cost per accepted answer. That makes Not Diamond a category neighbor, but not an exact clone.

Not Diamond leads with model selection across providers and models. PETO should not compete head-on as another model router. The stronger market angle is agent effort intelligence: making every agent turn cheaper and better calibrated without changing the model, prompt, or workflow.

### What Not Diamond Does

Not Diamond positions itself as an intelligent model router for coding agents. Its public pitch is frontier-quality results at lower cost by choosing the right model for each request. Its product is not the model execution gateway itself. Instead, it is a decision layer that recommends which model or route to use, then the customer executes through their own gateway, SDK, or harness.

The product supports pre-trained routers, custom routers trained on customer eval data, feedback loops, cost/latency tradeoffs, and model pools. In practical stack terms:

```text
Agent or app
-> Not Diamond routing recommendation
-> customer gateway or SDK
-> selected model executes
```

### Is It A Routing Model Or A Decision Layer?

It is best understood as a decision layer powered by routing models. The API takes context plus candidate models and returns a recommendation. Custom-router training uses prompt examples, candidate responses, eval scores, and customer preferences to learn which model is likely to perform best under the chosen tradeoff.

Not Diamond is therefore above the model layer and adjacent to gateways. It can integrate with gateways, but its differentiation is the routing decision, not the transport layer.

### Effort Optimization Relevance

Effort optimization appears to be a growing secondary capability for Not Diamond, especially for coding agents. Its materials discuss cost-quality tradeoffs, session outcomes, feedback, and in some contexts model plus reasoning-effort recommendations. However, effort optimization is not the main brand claim. Their main pitch remains cross-model routing: selecting the right model for the task to reduce spend and maintain or improve quality.

### Competitive Comparison

| Dimension | Not Diamond | PETO |
|---|---|---|
| Core object | Which model should answer? | What reasoning effort should a fixed model use? |
| Main pitch | Frontier quality at lower cost through model routing. | Lowest cost per answer the user accepts. |
| Layer | Decision layer above gateway / harness. | Gateway dispatcher plus evaluation discipline. |
| Scope | Cross-provider model selection, prompt optimization, custom routers. | Personalized effort routing, tokenomics, acceptance feedback. |
| Data basis | Eval data, feedback, model pools, session outcomes. | Acceptance, rejection, retries, underfit / overfit, token usage. |
| Risk | Wrong model choice, cache disruption, vendor dependency. | Underfit, narrower savings ceiling, effort API dependence. |
| Best buyer | Enterprise coding-agent teams with multi-model spend. | Agent platforms and teams standardized on a model but exposed to effort cost. |
| Complementarity | Can select model family or provider. | Can tune effort inside the selected model and workflow. |

### SWOT: Not Diamond

| Quadrant | Assessment |
|---|---|
| Strengths | Clear category ownership; strong coding-agent cost narrative; model/gateway distinction; custom-router and eval-data story; security and enterprise posture. |
| Weaknesses | Best results require customer eval data; cross-model routing can complicate cache economics; model choice is a moving target; trust/privacy hurdles. |
| Opportunities | Coding-agent inference spend is rising; gateways need intelligent routing; enterprise buyers want cost controls; routing can become AI infrastructure. |
| Threats | Gateways add native routing; model providers add auto-routing or auto-effort; open-source routers commoditize the base layer; customers build in-house. |

### SWOT: PETO

| Quadrant | Assessment |
|---|---|
| Strengths | Sharper wedge; no model switching required; personalized acceptance thesis; proof-grade evidence on clean slice; natural fit for Codex / Claude Code / Cursor-style agents. |
| Weaknesses | Narrower economic ceiling than model routing; proof-eligible slice is limited; V1 does not claim model selection; effort knobs vary by provider. |
| Opportunities | Own effort intelligence beneath every agent; pair with RouteLLM or Not Diamond; package as gateway plugin plus MCP observability. |
| Threats | Model routers can add effort as a feature; providers may hide or auto-manage effort; customers may dismiss effort savings unless tied to dashboards and proof. |

### PETO Market Review

There is a real market cause: agent inference spend is becoming painful. The buyer pain is not token shaving in isolation; it is AI agent spend governance without degrading accepted quality. PETO has a credible wedge because it optimizes a layer that model routers often treat as secondary: how much reasoning a given user, workflow, and task actually needs.

The proof surface should stay honest. PETO V1 currently claims approximately 17.6% exact savings versus fixed xhigh on a bounded proof-eligible answerable effort-sensitive slice, with 30 matched representative routes and complete execution/judge evidence. It does not claim capability-sensitive traffic, local artifact work, workspace action tasks, or model selection.

### Recommended Positioning

Do not lead with "another model router." Lead with:

> PETO makes AI agents economically self-aware. Every turn is routed to the cheapest reasoning level likely to satisfy the user, with evidence for savings and underfit.

Recommended packaging:

- Primary package: OpenAI-compatible gateway plugin for every-message pre-inference routing.
- Secondary package: MCP / tool layer for inspection, feedback, dashboards, and effort lessons.
- Agent distribution: skills/plugins for Codex, Claude Code, Cursor, OpenCode, and internal agent shells.
- Future strategy: pair with RouteLLM or Not Diamond. Let them choose model; PETO chooses effort, budget, retry policy, and acceptance calibration.

Best one-line market angle:

> PETO is the effort intelligence layer for AI agents.

## 中文版

### 核心结论

Not Diamond 是一个面向 coding agents 的模型路由决策层。PETO 更窄，也更锋利：它不是先选择不同模型，而是在固定执行模型之内选择 reasoning effort，用更低 token 成本换取用户仍然接受的答案。两者是同一大类里的相邻产品，但不是完全同质竞争。

Not Diamond 的主叙事是跨模型选择：在不同模型、供应商和成本质量权衡之间，选择最适合当前请求的模型。PETO 不应该把自己包装成另一个 model router。更好的切入点是 agent effort intelligence：不改模型、不改 prompt、不改 workflow，让每一次 agent 调用用刚好够的推理强度。

### Not Diamond 做什么

Not Diamond 把自己定位为 coding agents 的 intelligent model router。它的公开卖点是以更低成本获得接近 frontier model 的质量：每个请求先经过路由判断，再选择最合适的模型。它不是 gateway 本身，而是位于 agent/app 与执行层之间的决策层。客户仍然通过自己的 gateway、SDK 或 harness 去执行模型调用。

它支持预训练 router、自定义 router、基于客户 eval 数据的训练、反馈闭环、成本/延迟权衡，以及候选模型池。实际架构可以理解为：

```text
Agent 或 app
-> Not Diamond 路由建议
-> 客户 gateway 或 SDK
-> 被选中的模型执行
```

### 它是路由模型，还是上层决策层？

更准确地说，Not Diamond 是由路由模型驱动的决策层。API 输入上下文和候选模型，输出推荐模型。自定义 router 会利用 prompt、候选模型回答、eval 分数和客户偏好来学习“什么任务该给哪个模型”。

因此它在模型层之上、gateway 旁边，核心价值是选择决策，而不是流量转发。

### 它与 effort optimization 的关系

Not Diamond 已经在 coding-agent 场景里谈到成本质量权衡、session outcome、反馈、甚至模型与 reasoning effort 的共同建议。但从品牌主线看，effort optimization 不是它的第一卖点。它的主卖点仍然是 model routing：通过选择合适模型降低成本、保持或提升质量。

### 竞争对比

| 维度 | Not Diamond | PETO |
|---|---|---|
| 核心对象 | 哪个模型来回答？ | 固定模型应该用什么 reasoning effort？ |
| 主卖点 | 通过模型路由，以更低成本获得 frontier 质量。 | 以最低成本得到用户愿意接受的答案。 |
| 所在层级 | gateway / harness 上方的决策层。 | gateway dispatcher 加评估纪律。 |
| 产品范围 | 跨供应商模型选择、prompt optimization、自定义 router。 | 个性化 effort routing、tokenomics、acceptance feedback。 |
| 数据基础 | eval 数据、反馈、模型池、session outcome。 | 接受、拒绝、重试、underfit / overfit、token usage。 |
| 主要风险 | 选错模型、破坏 cache、供应商依赖。 | underfit、节省上限较窄、依赖 effort API。 |
| 最佳买家 | 有多模型支出的企业 coding-agent 团队。 | 已固定模型但 reasoning cost 明显的 agent 平台和团队。 |
| 互补关系 | 负责选择模型或供应商。 | 负责在被选模型内部调 effort、预算、重试策略。 |

### SWOT：Not Diamond

| 象限 | 判断 |
|---|---|
| Strengths 优势 | 品类叙事清晰；coding-agent 成本故事强；能讲清 model router 与 gateway 的区别；自定义 router 和 eval 数据故事完整；企业安全姿态较好。 |
| Weaknesses 劣势 | 最佳效果依赖客户 eval 数据；跨模型路由可能影响 cache 经济性；模型能力变化太快；客户信任和隐私门槛较高。 |
| Opportunities 机会 | coding-agent 推理成本快速上升；gateway 需要智能路由；企业买家需要成本控制；routing 有机会成为 AI infra 标配。 |
| Threats 威胁 | gateway 自带 routing；模型厂商内置 auto-routing / auto-effort；开源 router 商品化基础能力；大客户自研。 |

### SWOT：PETO

| 象限 | 判断 |
|---|---|
| Strengths 优势 | 切口更窄更清晰；不要求切换模型；个性化 acceptance thesis 强；clean slice 上已有 proof-grade evidence；天然适合 Codex / Claude Code / Cursor 类 agent。 |
| Weaknesses 劣势 | 经济上限比 model routing 窄；proof-eligible slice 有边界；V1 不主张模型选择；不同 provider 的 effort knob 不完全统一。 |
| Opportunities 机会 | 成为所有 agent 下面的 effort intelligence；与 RouteLLM 或 Not Diamond 互补；包装成 gateway plugin 加 MCP observability。 |
| Threats 威胁 | model router 可以把 effort 做成一个 feature；模型厂商可能隐藏或自动管理 effort；如果没有 dashboard 和 proof，客户会低估 effort savings。 |

### PETO 的市场价值复盘

PETO 的市场原因是成立的：agent 推理成本正在变成真实痛点。买家真正要的不是抽象的“省 token”，而是不降低可接受质量的 agent spend governance。PETO 的机会在于模型路由通常只把 effort 当附属参数，而 PETO 把“某个用户、某类工作流、某种任务到底需要多少 reasoning”变成核心对象。

但 PETO 必须保持 claim 边界诚实。V1 当前能主张的是：在 bounded、proof-eligible、answerable、effort-sensitive slice 上，相比 fixed xhigh baseline，有约 17.6% exact token savings；样本是 30 个 matched representative routes，且 execution / judge evidence complete。它不主张 capability-sensitive traffic、本地 artifact、workspace action、tool execution 或模型选择。

### 推荐定位

不要说“我们也是 model router”。更好的说法是：

> PETO makes AI agents economically self-aware。每一轮都被路由到最便宜且大概率能让用户接受的 reasoning level，并且用证据证明 savings 与 underfit。

推荐包装：

- 主包装：OpenAI-compatible gateway plugin，用于 every-message pre-inference routing。
- 辅助包装：MCP / tool 层，用于查看、反馈、dashboard 和 effort lesson。
- 分发路径：Codex、Claude Code、Cursor、OpenCode、内部 agent shell 的 skill / plugin。
- 未来战略：与 RouteLLM 或 Not Diamond 配合。它们选模型，PETO 选 effort、预算、retry policy 和 acceptance calibration。

最强一句话定位：

> PETO 是 AI agents 的 effort intelligence layer。

## Sources

- Not Diamond homepage: https://www.notdiamond.ai/
- Not Diamond docs: What is Model Routing: https://docs.notdiamond.ai/docs/what-is-model-routing
- Not Diamond docs: Key concepts: https://docs.notdiamond.ai/docs/key-concepts
- Not Diamond docs: Training a custom router: https://docs.notdiamond.ai/docs/router-training-quickstart
- Not Diamond API reference: modelSelect: https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post
- Not Diamond pricing / FAQ: https://www.notdiamond.ai/pricing
- RouteLLM blog: https://www.lmsys.org/blog/2024-07-01-routellm/
- RouteLLM paper: https://arxiv.org/abs/2406.18665
- PETO local launch contract: docs/peto-v1-launch-contract.md
