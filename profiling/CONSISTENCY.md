# Sequential initialization contract

Status: prototype contract with executable regression checks. This is not a formal proof of pnpm or filesystem crash recovery.

The validated profile uses a fixed v9 registry lockfile, `virtualStoreType: project`, an isolated Node.js linker, a files index, and disabled lifecycle scripts. The source manifests match the producer and lockfile. Effective global configuration, hooks, and the workspace remain fixed. A dedicated store has one writer at a time; every initialization in the workspace goes through this adapter.

For that profile, initialization of project A followed by B must retain the observable dependency resolution of A and match a combined install of their dependency closures. Repeating A must preserve those resolutions and need no additional cache objects. Observable checks include package versions, peer variants, executable bins, workspace links, the current lockfile's installed importers, and existing CAFS bytes.

## Runtime guards

- A workspace session binds its real workspace path, store path, lockfile, workspace YAML, native binary, Node.js/platform, root package/config files, explicit pnpm/npm configuration environment, and script mode.
- Catalogs include source manifest hashes. Selected projects and workspace dependencies must match them before hydration. Already visited manifests must remain unchanged.
- Store hydration never replaces an existing payload. Cached archives and CAFS content identities are checked. Completed payload chunks are SHA-512 checked again before reuse, including same-size changes. Native index metadata can change during installs and is retained.
- Parent-directory validation is shared only inside one operation with exclusive store access. A new operation validates its parents again. Payloads retain their individual checks. A catalog may carry the producer's workspace dependency closure; the consumer still checks the context and every selected source manifest.
- A workspace writer lock covers validation, hydration, native install, and the session commit. A second invocation fails before its native install begins.
- The session records an attempt before native install and records completion after successful install and input checks. Failure leaves that project pending. Other projects are blocked until the pending project succeeds on retry.
- A mismatched generation, changed store, malformed session, or untracked pre-existing node_modules stops initialization. There is no automatic migration of an existing installation.

The session files are `.pnpm-cache/initialization.json` and `.pnpm-cache/initialization.lock` under the workspace. Chunk completion records remain beside the store. A killed adapter can leave the writer lock behind. It is never stolen automatically. Confirm that its owner and native child have stopped before manually recovering the lock; retry the pending project. A changed generation requires a fresh workspace rather than deleting the session and adopting old node_modules.

## Executable evidence

`just test` and `just profile-test` cover rejection and recovery. A bounded reference model enumerates all 64 length-three sequences of success/failure attempts across two projects and checks the persisted pending/completed state after each step. This verifies that finite model against the adapter; it is not an unbounded theorem about native install.

```sh
just consistency-check /absolute/native/pnpm /fresh/output-directory
```

The native conformance check serves a deterministic local registry and creates a workspace with two versions of one dependency, two peer variants, executable bins, a shared registry dependency, and a linked workspace package. It compares all six orders of three project directories, plus a repeat, with a clean combined native install. Every step checks all previously initialized projects, current lockfile importers, append-only CAFS contents, and untouched projects. It also injects a corrupt archive and an interruption after native install but before the session commit, verifies the prior project still resolves, and retries. Consumers are offline and must make no registry requests.

The check runs in the `consistency` job of the prototype workflow. Its result is `consistency.json`. The Directus benchmark continues to exercise a larger real workspace.

## Boundary

The adapter does not make native install transactional. A failed install can leave the attempted project's node_modules incomplete; the pending state prevents claiming completion or proceeding to another project. Tests cover the listed failure boundaries, not every possible process termination or storage fault. Scripts, hooks, external edits/pruning, concurrent writers from other workspaces, and unvalidated dependency/store formats are outside this contract.
