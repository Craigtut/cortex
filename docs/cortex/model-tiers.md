# Model Tiers

> **STATUS: IMPLEMENTED**

Cortex uses two model tiers: a **primary model** for all consumer-facing work and a **utility model** for internal operations the user never directly sees.

## Tiers

### Primary Model

The main model configured by the consumer. Used for:
- The agentic loop (tool use, reasoning, replies)
- Primary inference phases (e.g., thinking, reflection)
- Any direct `agent.prompt()` calls

The consumer chooses this model based on their quality/cost preferences.

### Utility Model

A cheap, fast model for internal operations. Used for:
- WebFetch page summarization (the secondary LLM call)
- Auto-mode safety classifier (bash command classification)

Note: Compaction summarization uses the **primary model**, not the utility model. Conversation history summaries are the only record of what happened during agentic loops (tool calls, decisions, reasoning chains). Quality matters significantly here. See `compaction-strategy.md` for the rationale.

The user never sees utility model output directly. It powers behind-the-scenes operations where speed and cost matter more than peak quality.

### The duplex talker

One exception to "the user never sees it": a `CortexAgent` in its default duplex mode runs the talker on the same auto-resolved fast tier unless `talker.model` overrides it. The talker's output is exactly what the user sees first, so on a provider with no mapping below (where the fast tier resolves to the primary model) the talker is neither fast nor cheap, and Cortex warns at construction. Name a talker model explicitly on those providers. See `consumer-guide.md`.

## Configuration

```typescript
const agent = await CortexAgent.create({
  model: getModel('anthropic', 'claude-sonnet-4-6'),       // primary
  utilityModel: 'default',                                  // use provider default
  // or: utilityModel: getModel('anthropic', 'claude-haiku-4-5'),  // explicit
});
```

### `utilityModel` options:

- **`'default'`**: Cortex selects from a built-in mapping based on the primary model's provider. This is the recommended setting.
- **Explicit `Model` object**: The consumer specifies exactly which model to use. Must be from the same provider as the primary model (avoids needing multiple API keys).

### Provider Default Inference

Cortex infers the utility model from the provider's pi-ai catalog (`utility-model-inference.ts`): among the models whose names mark them as a small tier (mini, nano, haiku, flash, lite, small, 8B and similar), the newest wins, then the cheapest. "Newest" compares versions when both models have one, so a dated snapshot of an older version (`claude-haiku-4-5-20251001`) does not outrank a newer version without a date (`claude-haiku-5-5`), and compares release dates otherwise. `UTILITY_MODEL_OVERRIDES` pins a model for a provider when inference picks badly. The defaults follow pi-ai releases; with pi-ai 1.1.0 they include:

| Provider | Default Utility Model | Model ID | Price (input/output per 1M tokens) |
|----------|----------------------|----------|-------|
| Anthropic | Claude Haiku 5.5 | `claude-haiku-5-5` | $0.10/$0.50 |
| OpenAI | GPT-5.4 nano | `gpt-5.4-nano` | $0.20/$1.25 |
| Google | Gemini 3.8 Flash | `gemini-3.8-flash` | $0.75/$3.75 |
| Groq | Llama 3.1 8B | `llama-3.1-8b-instant` | $0.05/$0.08 |
| Mistral | Mistral Small 4 | `mistral-small-2603` | $0.15/$0.60 |

A duplex talker without a pinned model runs on this utility model. For providers whose models cannot be enumerated (Ollama, custom endpoints), the primary model is used as the utility model. Utility calls then cost the same as primary calls, but everything still works.

### Same-Provider Constraint

The utility model must be from the same provider as the primary model. This is enforced at construction time. Reason: using a different provider would require a separate API key and authentication, adding complexity. If the consumer needs cross-provider utility calls, they can configure the API keys for both providers and explicitly set the utility model.

## Accessing the Utility Model

Cortex exposes the utility model for internal use:

```typescript
// Internal to cortex (used by WebFetch, classifier, compaction)
const result = await cortexAgent.utilityComplete(context);

// Or access the raw model for direct pi-ai calls
const utilityModel = cortexAgent.getUtilityModel();
const result = await complete(utilityModel, context);
```

The `utilityComplete()` method is a convenience wrapper that uses the utility model with the same API key resolution as the primary model.

## Consumer Configuration

The consumer is responsible for providing UI or configuration for selecting the model tier, thinking level, and provider. Typical implementation patterns:

### Settings UI

Under the provider/model configuration:

- **Primary Model**: The main model selector.
- **Utility Model**: A secondary model selector, defaulting to "Recommended" (which maps to `'default'`). The list shows available models from the same provider, sorted by cost (cheapest first). "Recommended" is the first option and pre-selected.

### Recommended UI Behavior

- When the user changes the primary model's provider (e.g., switches from Anthropic to OpenAI), the utility model resets to "Recommended" for the new provider.
- The utility model list only shows models from the same provider as the primary model.
- A brief description explains what the utility model is used for: "A smaller model used for internal operations like web page summarization and safety checks. Does not affect the quality of the agent's main responses."

### Configuration Storage

The consumer stores both model selections in its own settings store:
- Primary model ID
- Utility model ID, or `'default'` for provider mapping

On startup, the consumer resolves `'default'` to the actual model ID using the provider mapping, then passes both models to the `AgentLoop` constructor.
