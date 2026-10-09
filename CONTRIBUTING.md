# Contributing to Cortex

Thank you for your interest in contributing to Cortex! We welcome contributions from the community.

## Before You Start

Cortex is an **opinionated framework** with a clear design philosophy. Before investing time in a pull request, please:

1. **Open an issue first.** Describe what you want to change and why. This lets us discuss whether the change aligns with the project vision before you write code.
2. **Read the product vision.** See `docs/cortex/product-vision.md` to understand what Cortex is (and is not). Cortex is a general-purpose agent framework, not an application. It provides hooks and callbacks; it does not contain domain-specific logic.
3. **Understand the architecture.** See `docs/cortex/cortex-architecture.md` for how the pieces fit together.

We review every PR carefully. Contributions that don't align with the project vision may not be merged, even if the code is well-written. Opening an issue first saves everyone time.

## Development Setup

### Prerequisites

- Node.js 24+
- npm (ships with Node.js)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/Craigtut/cortex.git
cd cortex

# Install dependencies
npm install

# Build all packages
npm run build

# Run type checking
npm run typecheck

# Run tests
npm run test:run
```

### Project Structure

```
/packages
  /cortex       - Core agent framework (@animus-labs/cortex)
  /cortex-code  - Coding agent CLI built on Cortex
/docs           - Architecture docs, tool references
```

## Making Changes

### Code Style

- **TypeScript strict mode** is required.
- Keep functions small and focused.
- Prefer composition over inheritance.
- Validate external input with Zod schemas.
- Add comments only for non-obvious logic.

### Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

**Format (single line only, no body):**
```
<type>(<scope>): <description>
```

**Examples:**
```
feat(cortex): add adaptive threshold to compaction manager
fix(cortex-code): show rejected edits as errors in TUI
docs(cortex): sync documentation with implemented codebase
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

**Scopes:** `cortex`, `cortex-code`, `docs`, `ci`

**Rules:**
- Single line only. No message body, no footer.
- Imperative mood: "add feature" not "added feature."
- Keep it under 100 characters.

### Testing

Every feature must have unit test coverage. We use [Vitest](https://vitest.dev/).

```bash
npm run test        # Watch mode
npm run test:run    # Single run
npm run test:coverage
```

### Pull Request Process

1. Fork the repo and create a branch from `main`.
2. Make your changes, following the code style and commit conventions above.
3. Ensure `npm run build`, `npm run typecheck`, and `npm run test:run` all pass.
4. Open a pull request with a clear description of what you changed and why.
5. Respond to review feedback.

### What Makes a Good Contribution

- **Bug fixes** with a test that reproduces the issue.
- **Documentation improvements** that fix errors or add clarity.
- **Performance improvements** with benchmarks showing the difference.
- **New features** that have been discussed in an issue first and align with the project vision.

### What Probably Won't Be Merged

- Application-specific logic (Cortex is a framework, not an app).
- Large refactors without prior discussion.
- Changes that break the sanitized boundary (Cortex must never import from a consumer package).
- Features that add persistence opinions (the consumer owns storage).

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs.
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for new ideas.
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## License

By contributing to Cortex, you agree that your contributions will be licensed under the [MIT License](LICENSE).
