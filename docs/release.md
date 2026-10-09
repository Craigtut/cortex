# Release process

Cortex uses separate tag-triggered release workflows for the framework and CLI packages. The workflows stage packages on npm with trusted publishing. A maintainer still approves the staged package with 2FA before it goes live. A package's first publication must be done manually because npm cannot stage a brand-new package.

No npm publish token should be stored in GitHub.

## Release paths

| Package | Workflow | Tag format |
| --- | --- | --- |
| `@animus-labs/cortex` | `.github/workflows/release-cortex.yml` | `cortex-vX.Y.Z` |
| `@animus-labs/cortex-code` | `.github/workflows/release-cortex-code.yml` | `cortex-code-vX.Y.Z` |

Each workflow rejects the release if the tag does not match the package version, if the changelog is missing that version, or if the package version is already published on npm.

The verify job builds and packs the tarball without OIDC publish permissions. The stage job has OIDC permission, but it does not check out repository code or install project dependencies. It only downloads the verified tarball artifact and stages that tarball on npm.

## One-time GitHub setup

Create a GitHub environment named `npm-publish`.

Recommended settings:

- Add required reviewers.
- Prevent self-review if there is more than one maintainer.
- Restrict deployment tags to `cortex-v*` and `cortex-code-v*`.

The environment approval happens before npm receives an OIDC token.

## One-time npm setup

Configure trusted publishing for each npm package after its first publication.

For `@animus-labs/cortex`:

- Publisher: GitHub Actions
- Repository: this repository
- Workflow filename: `release-cortex.yml`
- Environment: `npm-publish`
- Allowed action: `npm stage publish`

For `@animus-labs/cortex-code`:

- Publisher: GitHub Actions
- Repository: this repository
- Workflow filename: `release-cortex-code.yml`
- Environment: `npm-publish`
- Allowed action: `npm stage publish`

Then set each package's publishing access to require 2FA and disallow tokens.

The CLI workflow checks that its Cortex dependency is available on npm. Publish and approve Cortex before triggering the CLI release.

## Release 0.6.0

The registry check on 2026-09-06 found Cortex and Cortex Code at `0.5.0`, both
published from commit `1e88afe4b37435bf607ccc646bbf8acb1afdff66`. The sandbox
package returned 404. The next release set is:

| Order | Package | Version | Reason |
| --- | --- | --- | --- |
| 1 | `@animus-labs/cortex` | `0.6.0` | Breaking API restructure and new sandbox/duplex capabilities. |
| 2 | `@animus-labs/cortex-code` | `0.6.0` | New framework dependency, sandbox integration, and session format. |

This is a minor version boundary for the pre-1.0 packages, not a patch:
the former `CortexAgent` is now `AgentLoop`, the new facade defaults to duplex,
and saved CLI sessions cannot be read by older builds after migration. Existing
`^0.5.0` consumers will not automatically receive `0.6.0`. See each package's
changelog for the complete release notes.

Validate locally before release:

```bash
npm run release:check:cortex
npm run release:check:cortex-code
```

Publish and approve Cortex `0.6.0` through its tag workflow first, then Cortex Code `0.6.0`. Sandboxing ships inside Cortex; there is no third package or sandbox release workflow.

The Cortex tarball contains no native binary. Windows containment uses Microsoft's MXC runtime through the optional peer `@microsoft/mxc-sdk`, which Windows consumers install themselves. Managed sandboxing defaults to refusing unavailable or partial enforcement. Cortex Code explicitly retains degraded operation and Windows opt-in. Native Windows containment claims still depend on the real-host validation checklist in `docs/cortex/windows-sandbox-build.md`.

These are publishing instructions, not actions performed by local release preparation. npm and GitHub approvals still apply.

Local validation of the merged packages passed 3,653 tests (12 platform-specific skips), source typechecking, lint with no errors, and all 28 checked documentation examples. The CLI's 564 tests also passed against built Cortex. A clean install of the two tarballs passed CLI startup and real macOS sandbox setup, write containment, independent agent cleanup, and temporary-directory removal. The isolated production dependency audit reported zero vulnerabilities. Validation ran on macOS with Node 25.2.1; native Windows helper testing and signing were not run for this merge.

The separate test-source typecheck report remains a non-gating backlog (451 Cortex and 21 CLI diagnostics). The new sandbox tests have no diagnostics in that report.

## Prepare a Cortex release

```bash
npm version -w packages/cortex patch --no-git-tag-version
```

Update `packages/cortex/CHANGELOG.md` by moving the relevant `Unreleased` entries under the new version heading.

Commit the version and changelog changes:

```bash
git add package.json package-lock.json packages/cortex/package.json packages/cortex/CHANGELOG.md
git commit -m "chore(release): bump cortex to X.Y.Z"
```

Create and push the tag:

```bash
git tag cortex-vX.Y.Z
git push origin main
git push origin cortex-vX.Y.Z
```

After the workflow stages the package, review and approve the staged release on npmjs.com or with the npm CLI:

```bash
npm stage list @animus-labs/cortex
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

## Prepare a Cortex Code release

```bash
npm version -w packages/cortex-code patch --no-git-tag-version
```

Update `packages/cortex-code/CHANGELOG.md` by moving the relevant `Unreleased` entries under the new version heading.

Commit the version and changelog changes:

```bash
git add package.json package-lock.json packages/cortex-code/package.json packages/cortex-code/CHANGELOG.md
git commit -m "chore(release): bump cortex-code to X.Y.Z"
```

Create and push the tag:

```bash
git tag cortex-code-vX.Y.Z
git push origin main
git push origin cortex-code-vX.Y.Z
```

After the workflow stages the package, review and approve the staged release on npmjs.com or with the npm CLI:

```bash
npm stage list @animus-labs/cortex-code
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```
