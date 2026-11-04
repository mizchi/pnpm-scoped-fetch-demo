# Measure package downloads and compressed store transfers with a sparse checkout.
demo candidate baseline="pnpm":
    node demo.mjs --candidate {{quote(candidate)}} --baseline {{quote(baseline)}}

# Test cache identity, command arguments, and store isolation.
test:
    node --test test/*.test.mjs

# Exercise the Action's actual prepare/fetch scripts on a cache miss and hit.
action-demo candidate baseline="pnpm":
    node demo.mjs --action --expect-reduction --candidate {{quote(candidate)}} --baseline {{quote(baseline)}}

# Partition app dependency stores into shared and private transport chunks.
groups-demo candidate:
    node demo.mjs --groups --candidate {{quote(candidate)}}

# Install the optional native-store and GitHub cache tooling.
profile-setup:
    pnpm --dir profiling install --frozen-lockfile --ignore-scripts

# Check archive validation, cache transport, and benchmark accounting.
profile-test:
    node --test profiling/test/*.test.mjs

# Start the real GitHub cache experiment on the current published branch.
cache-benchmark branch="feat/github-cache-groups":
    gh workflow run prototype.yml --repo mizchi/pnpm-scoped-fetch-demo --ref {{quote(branch)}}

# Summarize downloaded benchmark artifacts.
cache-report directory="measurements":
    node profiling/ci/report.mjs {{quote(directory)}}

# Discover every lockfile importer and pack a fresh project catalog.
pack-projects workspace store binary output target="67108864":
    node profiling/pack.mjs --workspace {{quote(workspace)}} --store {{quote(store)}} --pnpm {{quote(binary)}} --output {{quote(output)}} --target-bytes {{quote(target)}}
