# Testing Requirements

## Framework
- Vitest

## Coverage
- Minimum 95%
- Target 100%

## Unit Tests
- Circuit Breaker
- Retry
- Timeout
- Bulkhead
- Rate Limiter
- Builder
- Fetch Adapter
- Metrics

## Integration Tests
- Local Express server
- Fake HTTP server
- Delayed responses
- Random failures
- Timeouts

## Stress Tests
Run with:
- 100 requests
- 500 requests
- 1000 requests
- 5000 requests

Measure:
- Latency
- Memory
- CPU
- Throughput

## Chaos Tests
- Random failures
- Random delays
- Random timeouts
- Connection resets

## Edge Cases
- null
- undefined
- rejected promises
- never resolving promises
- race conditions
- memory leaks
- AbortController

## Commands

```bash
npm test
npm run coverage
npm run benchmark
npm run stress
```
