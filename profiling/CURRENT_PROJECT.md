# Initialize the current project

Status: experimental adapter, not a published pnpm option.

The producer discovers every importer in `pnpm-lock.yaml`. It computes each importer's workspace and registry dependency closure, groups store files by their consumer sets, and subdivides groups with a byte target. The catalog maps importer IDs to immutable archive hashes. Jobs do not supply directory lists to the producer.

The consumer discovers its importer from the current `package.json` directory and the workspace root. It fetches only that project's referenced objects, hydrates a dedicated store, and runs `install --frozen-lockfile` with `recursiveInstall=false`. Workspace source dependencies must be checked out. Root registry tools are included to match the native install's observed behavior.

```sh
# Producer: a complete, freshly populated native store with storeIndexFormat=files.
node /absolute/demo/profiling/pack.mjs \
  --workspace "$WORKSPACE" --store "$FULL_STORE" --pnpm "$PNPM" \
  --output "$CACHE" --target-bytes 67108864

# Consumer: cwd is apps/web, packages/ui, or another package.json directory.
node /absolute/demo/profiling/initialize.mjs \
  --catalog "$CACHE/catalog.json" --cache-root "$CACHE" \
  --pnpm "$PNPM" --store "$LOCAL_STORE" --offline --ignore-scripts
```

Use an absolute native binary path and a dedicated store. The output directory must be fresh. Node.js 24+, tar, zstd, and `just profile-setup` are required for producing archives. The local consumer reads archive files; the GitHub Actions experiment uses `@actions/cache` to download the same objects.

The consumer retains chunk completion records beside the store. Another project reuses complete shared chunks and downloads its missing chunks. Missing files invalidate a completion record. Archive SHA-256 and CAFS SHA-512 identities are verified during hydration, and completed payloads are checked again before reuse. A workspace session pins the inputs and records interrupted attempts. See the [sequential initialization contract](CONSISTENCY.md) for recovery, writer exclusion, tests, and limits.

The adapter currently supports the pinned registry-only v9 lockfile and a files index. Its initial index archive covers the whole workspace; payload archives are selected per project. It includes development dependencies. Binary, platform, Node.js, workspace YAML, lockfile, root inputs, and selected source manifests must match the catalog. The producer needs all importer manifests. Effective global configuration and hooks require native planning support before general production use, as do Git, patches, build side effects, and arbitrary store formats.

Run the real service experiment with `just cache-benchmark`. The `on-demand` workflow discovers all Directus importers and compares whole-store, SDK-scoped store, chunks, and registry paths. Each strategy tests SDK alone and `packages/system-data → sdk → sdk` on three independent runners, for 24 consumers. Cache consumers restore exact hits from the GitHub Actions cache service and install offline. The registry control is online and has no measured registry byte count. Every consumer starts with sparse source and fresh local state and checks unchanged lockfile, unrelated-project isolation, and SDK module loading. `scoped-controls` preserves the earlier filtered-fetch comparison.

First-step timings include upfront store/catalog restoration. Reuse validation, SDK restoration, inner archive hydration, and native install are reported separately. The chunk path retains its additional archive and CAFS integrity checks; store/registry controls use the native verification policy. This is an end-to-end comparison of implemented paths, with that policy difference stated explicitly.

Chunking adds cache requests and archive work. Previous measurements found a single scoped archive faster than chunk restores. This experiment measures automatic selection and incremental sharing; it does not assume a speedup over direct registry downloads or a scoped archive.

The `chunk-tuning` experiment compares the pinned baseline implementation with the current implementation against identical cache objects. Twelve unprofiled consumers cover SDK alone and the staged sequence, with three fresh runners per implementation. Two additional diagnostic jobs collect Node CPU profiles and inclusive synchronous filesystem call counts; they are excluded from timing statistics. The catalog's optional workspace selection reuses the producer's existing dependency closure. Older catalogs fall back to lockfile parsing.
