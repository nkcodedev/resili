# Resili

## Overview
Resili is a production-ready TypeScript resilience toolkit for Node.js applications.

## Vision
Provide a modern, lightweight, TypeScript-first resilience toolkit that protects applications against failures.

## Initial Features
- Circuit Breaker
- Retry
- Timeout
- Bulkhead
- Rate Limiter
- Fallback
- Metrics
- Fetch Adapter
- Axios Adapter
- Express Middleware
- Event Hooks

## Goals
- Zero/minimal runtime dependencies
- TypeScript-first
- ESM + CommonJS
- Tree-shakable
- Production ready
- Framework agnostic
- Excellent DX
- Comprehensive documentation

## Target Platforms
- Express
- NestJS
- Fastify
- AWS Lambda
- Azure Functions
- Cloud Functions
- Microservices
- AI Applications

## Node Version
>=20

## Coding Standards
- Strict TypeScript
- No `any`
- ESLint
- Prettier
- SOLID
- Clean Architecture
- Composition over inheritance

## Folder Structure

src/
  core/
  adapters/
  metrics/
  utils/
  types/
tests/
examples/
docs/

## Example API

```ts
const client = resilience(fetch)
  .timeout(3000)
  .retry(3)
  .circuitBreaker()
  .bulkhead(20)
  .fallback(() => cachedData)
  .build();

await client("https://api.example.com");
```
