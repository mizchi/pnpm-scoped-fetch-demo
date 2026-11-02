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
