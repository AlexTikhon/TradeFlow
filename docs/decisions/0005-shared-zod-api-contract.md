# 0005. Shared Zod schemas as the API contract

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The API must validate its inputs, the frontend needs accurate response types, and we want an
OpenAPI document for external consumers and tooling. Three sources of truth (Nest DTO classes, a
hand-written frontend type file, and Swagger decorators) drift apart, and a drifted contract is a
production bug, not a compile error.

## Decision

`packages/contracts` holds **Zod 4 schemas** for every request and response shape, plus their
inferred TypeScript types.

- **API:** `ZodValidationPipe` parses params, query and body with these schemas. Service return
  types are the contract types, so a mapping that omits or mistypes a field fails compilation.
- **OpenAPI:** schemas registered in `apiSchemaRegistry` are converted with `z.toJSONSchema`
  (OpenAPI 3.0 target) into `components.schemas`. Routes still come from Nest controller metadata.
- **Web:** the HTTP client validates every response against its schema at the trust boundary, and
  test fixtures are typed with the same types.

## Alternatives considered

- **Nest DTO classes with `class-validator` plus `@nestjs/swagger` decorators, and frontend types
  generated from OpenAPI (`openapi-typescript`).** This is the idiomatic Nest approach and is
  language-agnostic. It needs a codegen step in the build, decorators duplicate type information,
  and it gives no runtime validation in the frontend.
- **tRPC or ts-rest.** End-to-end types with less ceremony, but either the HTTP API stops being
  plain REST (tRPC) or another framework layer joins the stack (ts-rest). We want a conventional
  REST API that a non-TypeScript client could consume.
- **Hand-maintained types on both sides.** Rejected: guaranteed drift.

## Consequences

- One edit changes validation, types and docs together. Contract drift becomes a compile error, or
  at worst a clear `ApiContractError` at runtime when deployments are skewed.
- Zod ships in the frontend bundle (a cost of tens of kB). Validating responses also costs some CPU
  on large payloads; we can sample or skip validation for bulk endpoints if profiling shows it
  matters.
- The contract package must stay free of domain logic. It describes the wire, not the business
  rules.
- The Zod-to-OpenAPI bridge is ours to maintain: about 20 lines, covered by a test asserting all
  `$ref`s resolve.
