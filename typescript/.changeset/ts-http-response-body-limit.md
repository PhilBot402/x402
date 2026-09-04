---
"@x402/fetch": patch
---

Bound 402 response bodies read by the fetch payment client to 1 MiB. A larger body throws `ResponseBodyTooLargeError`.
