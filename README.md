# Cortex

Production-grade agent framework with structured context management. By [Animus Labs](https://github.com/Craigtut/cortex).

Cortex treats the LLM context window as a managed surface, not a flat chat log. Named slots with stability-ordered layout maximize prompt cache hit rates. Observational memory is the default compaction strategy, with classic string trimming, summarization, and emergency truncation available when needed.

Built on `@earendil-works/pi-agent-core` for the agentic loop and `@earendil-works/pi-ai` for model access.

## Packages

| Package | Description |
|---------|-------------|
| [`@animus-labs/cortex`](packages/cortex/) | Core agent harness |
| [`@animus-labs/cortex-code`](packages/cortex-code/) | Terminal-based coding agent |

## Getting Started

```bash
npm install @animus-labs/cortex
```

For the terminal coding agent:

```bash
npm install -g @animus-labs/cortex-code
cortex
```

```typescript
import { AgentLoop, ProviderManager } from '@animus-labs/cortex';

const providers = new ProviderManager();
const model = await providers.resolveModel('anthropic', 'claude-sonnet-4-20250514');

const agent = await AgentLoop.create({
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'You are a helpful assistant.',
  // Optional. If omitted, pi-ai falls back to provider environment variables.
  getApiKey: async (provider) => {
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    throw new Error(`No API key configured for ${provider}`);
  },
});

agent.onTurnComplete((output) => {
  if (output.userFacing) console.log(output.userFacing);
});

await agent.prompt('What files are in this directory?');
await agent.destroy();
```

## Key Capabilities

- **Context Slots**: Named, stability-ordered content blocks optimized for prompt cache hit rates. Ephemeral context provides per-loop injection without polluting persistent history.
- **Compaction**: Observational memory by default, classic microcompaction and summarization available by config
- **Built-in Tools**: Bash, TaskOutput, Read, Write, Edit, UndoEdit, Glob, Grep, WebFetch, SubAgent
- **MCP Support**: Integrate external tool servers via the Model Context Protocol
- **Skills**: Progressive disclosure system for dynamic capability loading
- **Provider Management**: Multi-provider support, OAuth where available, API key validation, and custom OpenAI-compatible endpoints
- **Budget Guards**: Token and cost limits to prevent runaway execution

## Development

Requires Node.js 24+.

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm run test:run

# Type check
npm run typecheck
```

## Documentation

Start with the [Cortex consumer guide](docs/cortex/consumer-guide.md). Architecture guides, tool references, and integration notes live in [`docs/cortex/`](docs/cortex/).

## License

MIT
