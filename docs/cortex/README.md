# Cortex Documentation

Start here if you are integrating `@animus-labs/cortex` into an application:

- [Using Cortex](./consumer-guide.md): install, create an agent, configure providers, slots, persistence, permissions, MCP, tools, skills, compaction, and shutdown. `CortexAgent` is the entry point and duplex is its default mode.
- [Built-in Tools](./tools/README.md): tools registered automatically on the reasoner loop.
- [Provider Manager](./provider-manager.md): provider discovery, OAuth, API key validation, custom endpoints, and model resolution.

Architecture and implementation references:

- [Duplex Architecture](./duplex/README.md): the talker/reasoner design, its decision record, and the migration plan

- [Product Vision](./product-vision.md)
- [Cortex Architecture](./cortex-architecture.md)
- [CortexAgent Facade](./cortex-agent.md): the composite facade over AgentLoop, and the delegation table a migration reads
- [Context Manager](./context-manager.md)
- [System Prompt](./system-prompt.md)
- [Working Tags](./working-tags.md)
- [Model Tiers](./model-tiers.md)
- [MCP Integration](./mcp-integration.md)
- [Skill System](./skill-system.md)
- [Observational Memory Architecture](./observational-memory-architecture.md)
- [Compaction (tool result trimming and the failsafe)](./compaction-strategy.md)
- [Tool Result Persistence](./tool-result-persistence.md)
- [Error Recovery](./error-recovery.md)
- [Cross-Platform Considerations](./cross-platform-considerations.md)

Most files in this directory are design and implementation notes. The consumer guide is the primary end-user documentation for embedding the package.
