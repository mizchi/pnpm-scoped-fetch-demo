# Scoped pnpm fetch action

For initialization inferred from the current package directory, see the [current-project prototype](profiling/CURRENT_PROJECT.md). It discovers all importers automatically and shares immutable chunks between projects.


The experimental [cache groups prototype](./CACHE_GROUPS.md) splits an `apps/*` and `packages/*` workspace into shared and app-specific chunks. Its local demo measures selective transfer and reuse after an unrelated app update.

Restore, populate, and save a dedicated pnpm store for a selected lockfile scope. The following install or build step consumes the store through the `store-dir` output.

This action requires Node.js 24+ and a preinstalled native pnpm binary containing the scoped-fetch implementation. The released 12.16.1 used in the demo does not support it. The action does not install pnpm or infer support from the reported version. Until a supported release is published, supply the patched binary explicitly.

## Test the unpublished prototype on GitHub

The Rust implementation is available at [`mizchi/pnpm`, `feat/scoped-fetch`](https://github.com/mizchi/pnpm/tree/feat/scoped-fetch). The sample workflow pins commit `2ebada3ddfba7c0066efb29f4d4c07cb84cb9923`; no npm publication is needed.

Run [Test the pnpm prototype](https://github.com/mizchi/pnpm-scoped-fetch-demo/actions/workflows/prototype.yml) from the Actions tab, or use:

```sh
gh workflow run prototype.yml -R mizchi/pnpm-scoped-fetch-demo
gh run list -R mizchi/pnpm-scoped-fetch-demo --workflow prototype.yml
```

The optional `pnpm-ref` input selects another commit or branch in `mizchi/pnpm`. The workflow records the resolved commit, builds a native Linux x64 binary, verifies its checksum and uploads `prototype-pnpm-linux-x64`. Only the binary is cached for repeated builds; the large Cargo target directory is not transferred. This demonstration build disables release LTO to shorten compilation.

Separate fresh runners then exercise the actual composite Action and GitHub's cache service. The first job must miss and save the web store. The second must hit the same key, fetch with offline mode enabled and install offline. A run-specific salt guarantees that the first job starts cold. Both jobs use a real sparse checkout of [`fixture/`](./fixture/), omitting admin while retaining its entry in the lockfile. The fixture trusts its committed lockfile to isolate package cache behavior.

Another job runs the synthetic transfer and cache-group demonstrations and uploads `prototype-transfer-results`. Cache-group transfers still use the local HTTP backend; the real GitHub cache check covers the scoped-store Action.

## Use the action

Copy `action.yml` and `action/` into the application repository root for local use. A complete workflow template, including sparse checkout and package manager setup, is in [`examples/scoped-install.yml`](./examples/scoped-install.yml). Its `pnpm-version` input must name a published build that contains the feature; replace that setup step with your binary installer when using an unpublished build.

After checkout, Node.js setup, and installation of the patched pnpm:

```yaml
- name: Fetch web dependencies
  id: deps
  uses: ./
  with:
    pnpm-binary: pnpm
    filters: |
      {apps/web}...
    include-workspace-root: 'true'
    save-cache: ${{ github.ref_name == github.event.repository.default_branch }}

- name: Install web dependencies
  env:
    PNPM_BINARY: ${{ steps.deps.outputs.pnpm-binary }}
    PNPM_STORE_DIR: ${{ steps.deps.outputs.store-dir }}
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false'
  run: |
    "$PNPM_BINARY" --store-dir "$PNPM_STORE_DIR" --filter '{apps/web}...' install --frozen-lockfile --offline
```

Check out the application's workspace source dependencies too. The example includes `packages/ui`. pnpm reads the dependency graph from the lockfile, but sparse checkout still needs the source files that the build imports.

Leave `actions/setup-node` package manager caching disabled (`package-manager-cache: false`, with no `cache: pnpm`) and `pnpm/action-setup` installation disabled (`run_install: false`). This action owns the scoped cache. A global store restore before it would still transfer the large archive. [setup-node caching documentation](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#caching-packages-data).

## Cache behavior

1. Select a fixed, action-owned directory under `RUNNER_TEMP` and empty it before restoration. This prevents packages from a previous scope accumulating in the saved archive.
2. Restore an exact cache key. There are no fallback `restore-keys` that can pull in another scope or an old full store.
3. Run scoped fetch on both hits and misses. It verifies or fills the store using normal pnpm policies; failures stop the action. Automatic package manager version switching is disabled to keep the selected binary in use.
4. Save the fetched store on a miss when `save-cache` is enabled. The later install's changes are not part of this save.

The key includes filter order, production mode, root inclusion, pnpm version and executable hash, OS/CPU/libc, Node.js version, and hashes of the workspace lockfile, workspace configuration, project manifests, root npmrc/pnpmfile, and `patches/`. `cache-salt` adds a fingerprint for other inputs.

The full lockfile hash is used conservatively. An unrelated dependency change can invalidate a scoped cache. This implementation reduces the data restored for each scope; it does not implement a dependency-closure fingerprint or partial downloads from a GitHub cache archive. [GitHub cache restore implementation](https://github.com/actions/toolkit/blob/main/packages/cache/src/cache.ts).

`cache-hit` reports an exact cache match, not a completed install. A hit can still cause registry policy metadata requests. The demo verifies zero **package archive** requests after restoration. Never skip the following install based only on `cache-hit`.

The source store is separate from `node_modules` and build/task output caches. `RUNNER_TEMP` is suitable for GitHub-hosted Linux and macOS runners; on other runner layouts pnpm may copy files if the workspace is on a different filesystem. Windows has not been validated.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `filters` | Required | Newline-separated selectors, preserving inclusion/exclusion order. |
| `pnpm-binary` | `pnpm` | Native executable path or PATH command, with scoped-fetch support. |
| `working-directory` | `.` | Workspace root containing `pnpm-lock.yaml`, relative to the checkout. |
| `production-only` | `false` | Use `--filter-prod` and `--prod`; use `--prod` for the later install too. |
| `include-workspace-root` | `true` | Include the root tools that ordinary filtered installs also need. Disable only when the consuming operation does not need root dependencies. |
| `cache-salt` | Empty | Extra fingerprint, for example `${{ hashFiles('tooling/install/**') }}`. |
| `save-cache` | `true` | Set `false` for jobs that should restore but not save caches. |

Outputs are `store-dir`, `cache-hit`, `cache-key`, `pnpm-binary`, and `pnpm-version`. Passing `store-dir` to the following install is required. Saving only on the default branch lets pull requests consume a shared cache without uploading a separate entry on every change.

## Validation

```sh
just test
# Or: node --test test/*.test.mjs
just action-demo /path/to/patched/pnpm /path/to/released/pnpm
actionlint .github/workflows/test.yml examples/scoped-install.yml
```

The Action demo executes the same prepare/fetch functions used by `action.yml`, first with an empty store and then after downloading and restoring its compressed store. It checks matching cache identities, no package downloads on the warm fetch, the offline install, module loading, and unchanged lockfiles. Its data is in [`action-results.json`](./action-results.json).

These are local tests of the Action scripts and archive transfer. The prototype workflow above exercises the GitHub cache service; local results alone do not establish its behavior. The included CI workflow runs unit tests automatically; a manual `pnpm-version` input also enables the transfer demo once a suitable published binary is available.

## Transfer demo

Measure how fetching a lockfile scope changes package downloads and the compressed store sent to a fresh runner.

The demo creates a Git repository, performs a real sparse checkout of `apps/web` and `packages/ui`, and serves deterministic package archives from a local HTTP registry. The omitted admin application owns a 16 MiB dependency. The web application uses a shared workspace package and a transitive registry dependency. Root build tools are selected explicitly.

Requires Node.js 24+, Git, tar, zstd, and native pnpm binaries. No npm dependencies or external registry access are needed.

```sh
node demo.mjs --baseline /path/to/released/pnpm --candidate /path/to/modified/pnpm --expect-reduction
# Or:
just demo /path/to/modified/pnpm /path/to/released/pnpm
```

`--admin-mib 64` changes the omitted application's payload size. Each invocation uses fresh stores under `.work/`. `results.json` records the latest measurement, including the actual pnpm versions used.

The scenarios are:

| Scenario | Command |
|---|---|
| baseline-full | Released pnpm, `fetch` |
| baseline-filtered | Released pnpm, `fetch --filter '{apps/web}...' --workspace-root` |
| candidate-full | Modified pnpm, `fetch` |
| candidate-filtered | Modified pnpm, `fetch --filter '{apps/web}...' --workspace-root` |

The reduction is calculated between the two candidate scenarios, so their binary, platform, compression, and configuration match. The released binary also demonstrates whether its filter changes the fetched scope.

For every scenario the demo:

1. Counts the package archive bytes actually served over HTTP.
2. Archives the resulting dedicated store with tar and zstd level 3.
3. Downloads that archive over HTTP into a separate file and verifies its contents.
4. Restores the store beside another sparse checkout.
5. Runs `install --frozen-lockfile --offline --filter '{apps/web}...'` with the restored store, checks that it requests no package, and loads both a registry dependency and the workspace dependency from the web application.
6. Checks that fetching and installing leave the source lockfile unchanged.

`--expect-reduction` fails if the candidate fetches the admin package or if either transfer fails to shrink. Running the unmodified binary as both baseline and candidate therefore demonstrates the failing case.

The fixture trusts its generated lockfile to isolate package transfer from registry policy metadata requests. Package archives still carry SHA-512 integrity hashes. No production configuration is changed.

This measures actual bytes on a local HTTP connection. It does not measure GitHub's throughput or job duration. Payloads are synthetic, so the percentages demonstrate the mechanism and do not predict a production repository's savings. Historical packages in a reused store would also be archived; the demo deliberately uses a separate store for each scope.

GitHub's cache action restores an entire cache archive. Using this result in Actions requires saving the scoped store separately and restoring that cache, rather than first restoring a full-workspace store.

## Recorded measurement

Measured on macOS arm64 on 2026-11-02 with the default synthetic fixture. The released binary reports 12.16.1; the modified binary reports 12.17.0.

| Metric | Candidate, full fetch | Candidate, scoped fetch | Reduction |
|---|---:|---:|---:|
| Package archive bytes | 17,244,097 | 461,013 | 97.3% |
| Compressed store bytes | 34,493,233 | 469,152 | 98.6% |

Both restored stores passed the offline install and module-loading checks. Exact data is in [`results.json`](./results.json).
