# Experimental GitHub cache groups

Run `just cache-benchmark feat/github-cache-groups` after publishing the branch.
The manually dispatched `prototype.yml` workflow measures the actual GitHub cache service.
This is a benchmark adapter for the unpublished Rust pnpm prototype, not a released pnpm command.

The workload is Directus at `e0444f46909d530c4af243313a5320571992a30c`.
The native pnpm source defaults to `2ebada3ddfba7c0066efb29f4d4c07cb84cb9923`.
It uses Node 24.21.0, a trusted immutable lockfile, disabled install scripts, and isolated package metadata caches.
The setup moves the existing overrides to workspace configuration and disables engine checks for this pinned fixture.

The workflow runs these phases:

1. Fetch SDK dependencies into an empty native store. Validate a frozen offline install, module load, and unchanged lockfile.
2. Fetch the full workspace once. Derive scoped indexes and CAFS inventories from its lockfile graph. Require the SDK inventory to match the independent native fetch.
3. Partition CAFS files by their consumer sets and deterministic hash prefixes, targeting 16 or 64 MiB of uncompressed content. Stream deterministic tar/zstd archives, then validate them.
4. Save immutable objects using `@actions/cache`. Publish a small plan mapping a workload to its archive hashes. A plan contains no per-file inventory.
5. Restore on fresh runners using sparse checkouts and their workspace dependency closures. Compare a full-store cache, a scoped-store cache, and both SDK chunk sizes, using three runners for each strategy. Also validate the app and API scopes with 64 MiB chunks.

The full-store baseline stores the native `files`, `index`, and `index-aliases` directories in one SDK cache entry. The scoped baseline stages only SDK payload files and its index, without an inner archive or custom hydration. Its payload fingerprint must match the independent native SDK fetch. Chunk entries contain precompressed archives, so the SDK adds an outer archive. The report includes its compressed size rather than counting only the inner payload. Plan transfer is included in every strategy.

The scoped baseline isolates selection from chunking. A reduction against the full store cannot by itself establish a benefit from chunking. Summary version 2 requires all 14 warm samples and verifies that SDK consumer checkouts omit the unrelated app and API manifests.

CAFS paths encode SHA-512 content identities. Restoration validates these identities, archive SHA-256, file counts, expanded sizes, normalized permissions, safe paths, and index key identities before linking staged files into a fresh store. The plan digest comes from the producer output. Frozen offline install verifies usability without registry fallback.

Cache keys use a run-specific namespace to force the cold and producer stages to miss. Object paths stay stable because the SDK includes them in cache versions. A reusable deployment would use a stable namespace and retain unchanged content hashes across runs.

Measurements record GitHub REST `size_in_bytes` for every restored object, cache hits, plan size, restore time, hydration time, offline install time, and total time. HTTP headers and control requests are excluded. Runner setup, dependency tooling installation, checkout, and binary artifact download are outside the timed interval. Producer fetch, packing, verification, and upload costs are recorded separately. Three samples describe one run; they do not establish p95 performance.

The `cache-benchmark-summary-*` artifact contains JSON and Markdown. Missing samples, unexpected warm misses, or failed validation make reporting fail. Download all `cache-benchmark-*` artifacts into a directory and run `just cache-report DIRECTORY` to reproduce the summary.

For local checks, run `just profile-setup`, `just test`, and `just profile-test`.
