/**
 * The package.json shapes a Cortex release publishes.
 *
 * Besides `@animus-labs/cortex@<version>`, every release publishes a Windows
 * variant, `@animus-labs/cortex@<version>-win32`: package.json only, `os:
 * ["win32"]`, with Microsoft's MXC sandbox SDK as its one dependency. The main
 * package names it as an optional dependency through an npm alias, so npm
 * fetches it (and the SDK, about 170 MB with node-pty) on Windows and skips it
 * everywhere else. This is the shape OpenAI's Codex CLI uses for its platform
 * builds.
 *
 * The alias is added here, at staging time, not in packages/cortex/package.json:
 * the repository's own installs would otherwise resolve a version that is not
 * published yet, and npm records an unresolvable optional dependency as
 * absent, which breaks `npm ci` once the version does appear.
 */

/** The dist-tag the variant is published under, so `latest` never moves to it. */
export const WIN32_DIST_TAG = 'win32';

/** Exact pin: the SDK version the MXC backend was validated against. */
export const MXC_SDK = { name: '@microsoft/mxc-sdk', version: '1.0.0' };

export function win32VariantVersion(version) {
  return `${version}-${WIN32_DIST_TAG}`;
}

/** The Windows variant's whole package.json, derived from the main manifest. */
export function win32VariantManifest(main) {
  return {
    name: main.name,
    version: win32VariantVersion(main.version),
    description:
      `Windows dependencies of ${main.name} ${main.version} (Microsoft's MXC sandbox SDK). ` +
      `npm installs this automatically on Windows; do not depend on it directly.`,
    license: main.license,
    author: main.author,
    repository: main.repository,
    bugs: main.bugs,
    homepage: main.homepage,
    os: ['win32'],
    dependencies: { [MXC_SDK.name]: MXC_SDK.version },
  };
}

/**
 * The main package.json as published: the repository manifest plus the
 * optional alias to the variant, placed after `dependencies`. `alias` is the
 * directory name Cortex resolves the SDK through (MXC_SDK_PLATFORM_PACKAGE).
 */
export function stagedMainManifest(main, alias) {
  if (main.peerDependencies?.[MXC_SDK.name] || main.dependencies?.[MXC_SDK.name]) {
    throw new Error(`${main.name} must not declare ${MXC_SDK.name} itself; the Windows variant carries it`);
  }
  if (main.optionalDependencies?.[alias]) {
    throw new Error(`${main.name} already declares ${alias}; staging adds it`);
  }
  const optional = { ...main.optionalDependencies, [alias]: `npm:${main.name}@${win32VariantVersion(main.version)}` };
  const staged = {};
  for (const [key, value] of Object.entries(main)) {
    if (key === 'optionalDependencies') continue;
    staged[key] = value;
    if (key === 'dependencies') staged.optionalDependencies = optional;
  }
  staged.optionalDependencies ??= optional;
  return staged;
}
