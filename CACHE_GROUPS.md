# Cache groups for app workspaces

Status: experimental transport prototype. The existing scoped-fetch Action still saves one store per scope. Group planning and HTTP transfer run in the local demo; dynamic GitHub cache restore/save is not connected yet.

## Workspace and ownership

```text
apps/web   ── web-dep ────┐
   └─ packages/ui ────────┼── shared-dep
apps/admin ── admin-dep ──┘
workspace root ── root-tool
```

`apps/*` are entrypoints. pnpm follows their locked dependencies, including workspace links to `packages/*`, and includes root tooling explicitly. Workspace source comes from Git; package content comes from the store. An app does not need every directory under `packages/`.

The prototype calls the native scoped `pnpm fetch` for each entry into a fresh store. This delegates dependency analysis, aliases, peer resolution and optional dependency behavior to pnpm. It then inventories the content each entry actually needs. It does not implement a second lockfile resolver.

Files with the same set of consumers form a group:

```text
apps/web   → [web chunk, shared chunk]   + web index
apps/admin → [admin chunk, shared chunk] + admin index
```

The sharing unit is an immutable content file, which can be smaller than a package. An optional stable hash shard further divides large consumer groups. The planner takes `shards: 1..256`; the demonstration uses one shard to make ownership visible. Sharding limits invalidation within a group, but does not impose a byte-size limit.

## Manifest and keys

The simplified shape below shows references; the generated [`groups-manifest.json`](./groups-manifest.json) includes file digests, modes, sizes, environment and archive digests.

```json
{
  "entries": {
    "apps/web": { "imports": ["web-content-key", "shared-content-key"], "index": {} },
    "apps/admin": { "imports": ["admin-content-key", "shared-content-key"], "index": {} }
  },
  "chunks": {
    "web-content-key": { "consumers": ["apps/web"], "files": [] },
    "admin-content-key": { "consumers": ["apps/admin"], "files": [] },
    "shared-content-key": { "consumers": ["apps/admin", "apps/web"], "files": [] }
  }
}
```

Each content key hashes sorted file paths, content digests, sizes, modes and the compatibility context. The source lockfile hash is recorded for provenance, outside content keys. Updating only admin changes its chunk without invalidating web or shared chunks when their contents and grouping stay the same. Changes to consumer membership can regroup files and change keys.

The demonstration context includes the native executable digest, Node.js version, OS/architecture, store layout and workspace configuration. A production implementation also needs resolved configuration, patches, hooks, libc and other inputs that affect fetch output. Hashing an entire lockfile into every group would defeat independent reuse.

Content sharing does not merge dependency graphs. Different peer snapshots can share package bytes while retaining distinct links. Per-entry indexes and the original lockfile retain the information pnpm uses to install them.

## Store restoration

The prototype uses the existing `storeIndexFormat: files` backend in dedicated stores. It caches only immutable `files/` content and the selected entry's `index/` and `index-aliases/` metadata. It omits local clone caches under `links/`, build results and `node_modules`.

It does not combine SQLite databases or overwrite an existing general-purpose store. Restoring into a fresh store and running the regular frozen offline install verifies that the selected groups and index form a usable store. Normal pnpm performs the links.

The index is separate because verification timestamps can change while package bytes stay identical. The demo transfers the small index archive for each entry and measures it. Rebuilding an index does not change the content chunk keys.

## Reproduce

```sh
just test
just groups-demo /absolute/path/to/patched/pnpm
# Equivalent:
node demo.mjs --groups --candidate /absolute/path/to/patched/pnpm
```

The demo discovers the app entries in its generated repository. It fetches their locked closures, partitions immutable files, compresses and serves chunks, and restores only the selected imports over HTTP. Web is restored first, then admin with a local chunk archive cache; their shared chunk crosses the connection once. Both apps install offline and load their modules. Then the demo updates admin-dep from 1.0.0 to 2.0.0, commits the fixture update, fetches both scopes again and asserts that web's chunk keys stay unchanged while admin's change.

Recorded with the synthetic 16 MiB admin dependency:

| Transfer | Bytes |
|---|---:|
| All unique chunks and both indexes | 17,316,029 |
| Web chunks and web index | 464,744 |
| Additional admin data after web's shared chunk is present | 16,851,285 |

Web transfers 97.3% less than the full set. This compares the same group codec and store backend. It is separate from the earlier tar/zstd whole-store comparison. See [`groups-results.json`](./groups-results.json) for assertions and measurements. The bytes are measured locally; they do not estimate GitHub cache service latency or production savings.

## GitHub Actions boundary

The intended flow is:

1. A producer generates a small manifest and saves each immutable chunk separately under its content key. Index archives have separate keys.
2. A consumer selects `apps/web` from the manifest and restores its import keys and its index. When selecting several apps, it restores the union of their keys once.
3. The consumer runs scoped fetch to validate or fill a cache miss, then a frozen install with the resulting store. An absent chunk is a cache miss, not evidence that dependencies can be omitted.
4. Cache writes stay on trusted producer runs. A consumer uses a manifest tied to its current lockfile and compatible execution context.

The official `@actions/cache` SDK provides dynamic `restoreCache` and `saveCache` calls, which fit a manifest-sized list better than hardcoded composite-action steps. Each group is a distinct cache entry; this does not perform byte-range reads inside a cache archive. [SDK API](https://github.com/actions/toolkit/blob/main/packages/cache/README.md).

The existing [`action.yml`](./action.yml) remains the runnable scoped-store Action. It does not yet use these group keys. The prototype workflow builds the unpublished implementation from the fork and runs the group transfer demonstration. Group transfers use its local HTTP server, while the separate scoped-store smoke jobs exercise GitHub caching.

## General pnpm integration

The reusable core is selection and planning from a frozen lockfile. Storage transport should consume that plan; it should not own dependency semantics. A future read-only plan API should expose selected importers, snapshot edges and package content identities through the same traversal used by fetch. It must preserve peer contexts and apply dependency-group and platform choices consistently. GitHub cache grouping, remote stores, container preparation and sparse checkout tools could all consume it.

That API is not implemented by this prototype. The current producer first materializes every entry into separate stores, so it duplicates some download and disk work and cannot demonstrate cheap planning in a huge repository. The manifest also lists individual files, and the JSON/gzip codec buffers and base64-encodes content. Production work needs a bounded streaming format, fewer metadata round trips, authenticated manifest provenance, cache-miss handling, and measurements of producer CPU/disk/network cost as well as consumer transfer. A union of consumers alone can create many groups; stable buckets and size/coalescing policies need real workspace data.
