# Tests

JavaScript tests live next to the code and are started from the root:

```bash
npm test
```

- `shared-protocol/test` — codec, crypto, routing, groups, extractor, simulated three-node policy.
- `backend/test` — API, roles, sync, security negatives. Uses PGlite.
- `simulator/test` — partitions, expiry, duplicates, 1,000 and 10,000 logical nodes.
- `command-center/src/overview.test.tsx` — disclaimer and zero counts.

`physical-results.template.json` is a blank physical-device record. It is `NOT_RUN`. Do not fill it from the simulator.
