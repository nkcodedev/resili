# Circuit Breaker

## States
- Closed
- Open
- HalfOpen

## Configuration
- failureThreshold
- successThreshold
- timeout
- resetTimeout
- fallback

## Events
- onOpen
- onClose
- onHalfOpen
- onSuccess
- onFailure

## State Flow

Closed
→ failures reach threshold
→ Open
→ wait resetTimeout
→ HalfOpen
→ success threshold reached
→ Closed

Failure in HalfOpen returns to Open.
