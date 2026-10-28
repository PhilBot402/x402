---
"@x402/core": minor
"@x402/extensions": minor
"x402": minor
"@x402/evm": patch
"@x402/mcp": patch
"x402-axios": patch
"x402-express": patch
"x402-fetch": patch
"x402-hono": patch
"x402-next": patch
---

Depend on zod ^4.6.6 so GHSA-mrhx-c7xc-m3w5 (CVE-2023-54404) is fixed. There is no patched zod 3.x.

`PaymentRequired` `accepts`, the legacy `x402Response` and discovered-resource `accepts` arrays, legacy discovery `items`, legacy supported `kinds`, and SIWX `resources` now reject more than 1024 entries.

Inferred payment object types are unchanged. The re-exported `z`, schema classes, and `parsePaymentRequired` / `parsePaymentRequirements` / `parsePaymentPayload` results are zod 4. Code that passed those schemas into a zod 3 API, or read `ZodError.errors`, needs zod 4 (use `.issues`).

Legacy `processPriceToAtomicAmount` error text now uses zod 4 issue messages, for example "expected number to be >=0.0001".
