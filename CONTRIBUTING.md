# Contributing

## Start with the offline checks

Use **Bun 1.3.14 or newer**. CI uses **Bun 1.4.2**; development SDK dependencies and the compiled-host compatibility target are pinned to **OMP 18.8.7**. Earlier or later compatible host versions have not been established.

```sh
git clone https://github.com/ubranch/omp-cache-control.git
cd omp-cache-control
bun install --frozen-lockfile
bun run build:cache-replay
bun run typecheck
bun run test
```

The regression suite uses controlled clocks, mocked provider/cache-management calls, and genuine native SDK consumption against controlled loopback endpoints; native diagnostic-writer positive controls prove the privacy cases exercise active writers. It rejects unexpected paid requests. Do not add live credentials or paid provider calls to ordinary tests or CI. A local test pass proves controlled behavior, not a provider's cache-retention policy.

Then put the **native compiled OMP 18.8.7 executable** on `PATH` (or set `OMP_COMPILED_CLI` to it) and run:

```sh
bun run test:compiled
```

This E2E launches the real CLI in isolated RPC mode with an empty profile and no prompt. It requires `/cache` to be advertised without extension load failures, and rejects source launchers. It does not prove paid warming, provider retention, or native-TUI behavior. CI regenerates the helper and runs the controlled suite; a compiled executable is a separate prerequisite for this E2E.

## Keep the extension boring

The runtime entry point is [cache-control.ts](cache-control.ts), exported directly by the native `omp.extensions` manifest. Static supported SDK imports use OMP's host registry, including standalone compiled installations; do not resolve SDK packages beside the executable or import disk SDK sources at runtime. The shipped `cache-control-replay.js` is generated from exact **18.8.7** upstream replay helpers and `abortableSource`, whose source subpaths are absent from the compiled registry. Its public utility-root and transform-message dependencies remain external and host-resolved; it is not a second bundled runtime SDK. The public Bedrock event-stream codec, `@smithy/core` pinned to **3.35.0**, remains a normal root production dependency installed with the plugin.

`bun run build:cache-replay` uses the pinned local SDKs, preserves upstream implementation and license notices, and refuses mismatched helper versions. Keep the generated JavaScript and its upstream type re-exports in distribution alongside the reproducible build entry/script. A normal plugin install consumes the shipped helper without needing development SDKs; a clean development install can reproduce it. Never replace native sanitization or cancellation with hand-written copies or stubs.

- Fix shared lifecycle state, not one symptom at one hook. Preserve user-turn priority, identity/revision checks, cancellation, and transport cleanup.
- Preserve the actual cache-affecting prefix. Refuse an unsafe request rather than deleting thinking, tool definitions, or modalities to make it appear supported.
- New tests must exercise the actual application/service entry point as E2E checks; preserve existing controlled and native-loopback regressions. Replay changes must cover bounded output, matching usage, stale-context refusal, no chat-history mutation, and no uncontrolled retries or extra billing.
- Keep observed live evidence separate from inferred cadence and source-supported adapters. Do not add provider guarantees, savings percentages, or quota claims.
- Update affected docs and [CHANGELOG.md](CHANGELOG.md) with behavior changes. Keep commands searchable/copyable in Markdown; SVGs are static layout, not the documentation source.

Submit a focused [pull request](https://github.com/ubranch/omp-cache-control/pulls) describing the behavior, reason, regression coverage, and the exact checks you ran. Use [issues](https://github.com/ubranch/omp-cache-control/issues) for sanitized bugs or concrete feature requests. Report vulnerabilities [privately](SECURITY.md), not in an issue or pull request.

## Optional local plugin testing

Use OMP's native `omp plugin link` command with your checkout's absolute path, then **fully exit and restart OMP**. Plugins load at process startup; `/reload-plugins` does not reload TypeScript extensions. Linked plugins cannot use `omp plugin upgrade`; edit/pull the checkout and restart instead. Linking is optional and not required for the offline suite.

Inside the TUI, start with `/cache warm off` if you only need display/lifecycle inspection. A real eligible provider request and any warm-up can cost money. Do not run a live soak by default, and never commit provider keys, prompts, transcripts, user configuration, diagnostic captures, or disposable workspaces.

Unlink/remove the development plugin through `omp plugin uninstall omp-cache-control`, then fully restart OMP. See the README for native GitHub installation.

## Maintainer release procedure

1. Set the release version in `package.json`, update the dated changelog entry, and keep documentation/evidence claims tied to what was actually observed.
2. From a clean checkout, install with the committed lockfile, regenerate with `bun run build:cache-replay`, and run `bun run typecheck` and `bun run test`. Run `bun run test:compiled` against the exact compiled host target, then verify native plugin discovery/load. Record actual results separately from older SDK/live evidence and review the corresponding public CI result.
3. Review distributable files and dependency/runtime boundaries; include the regenerated helper and type artifact. Exclude credentials, user config, transcripts/logs, patched host packages, node_modules, temporary observers, and disposable workflow artifacts.
4. Inspect local README links and static SVGs at desktop and mobile widths. Preserve title/description/viewBox, system fonts, own background, and Markdown fallbacks.
5. Publish the reviewed commit and a matching version tag/GitHub release; then verify installation from the public GitHub reference in a clean plugin environment and fully restart OMP.

Distribution is through the native **GitHub plugin reference**. Package metadata is not a claim of npm publication. Publication credentials and release operations belong to maintainers, never the extension runtime or test suite.

[License](LICENSE) · [Security reporting](SECURITY.md) · [Verification boundaries](docs/verification.md)
