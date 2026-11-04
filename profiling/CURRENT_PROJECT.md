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

The consumer retains chunk completion records beside the store. Another project reuses complete shared chunks and downloads its missing chunks. Missing files invalidate a completion record. Archive SHA-256 and CAFS SHA-512 identities are verified during hydration. Completion records belong to the trusted local store and are not remote attestations. Existing pnpm integrity checks still run. Concurrent writers to the same store are not supported by this adapter.

The adapter currently supports the pinned registry-only v9 lockfile and a files index. Its initial index archive covers the whole workspace; payload archives are selected per project. It includes development dependencies. Binary, platform, Node.js, workspace YAML, and lockfile must match the catalog. Additional effective configuration and hook fingerprints are required before general production use. Git, patched packages, build side-effect caches, and arbitrary store formats need native planning support.

Run the real service experiment with `just cache-benchmark`. The `on-demand` workflow discovers all Directus importers and tests SDK alone and `packages/system-data → sdk → sdk` on three independent runners each. Every consumer starts with sparse source and an empty store and must pass offline install, unchanged lockfile, unrelated-project isolation, and SDK module loading checks. `scoped-controls` preserves the earlier full/scoped/chunk comparison.

Chunking adds cache requests and archive work. Previous measurements found a single scoped archive faster than chunk restores. This experiment measures automatic selection and incremental sharing; it does not assume a speedup over direct registry downloads or a scoped archive.
