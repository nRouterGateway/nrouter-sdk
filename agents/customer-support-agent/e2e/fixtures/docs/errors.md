---
title: API Error Codes
---

# Northwind Notes API Error Codes

When an API call cannot be completed successfully, Northwind Notes responds with an appropriate HTTP status code and a structured JSON error response.

## Common Error Codes

### 401 Unauthorized (Invalid Key)
Returned when an API key is missing, expired, revoked, or invalid. Verify that your request includes the `Authorization: Bearer <key>` header and that the key is active in **Settings → API keys**.

### 402 Payment Required (Out of Credits)
Returned when your organization credit balance has dropped to zero. API requests are halted until credits are replenished via **Billing → Add Credits** or through auto-recharge.

### 429 Too Many Requests (Rate Limited)
Returned when your request volume exceeds the organization throughput ceiling (requests per minute or tokens per minute). Review the `Retry-After` header and implement exponential backoff before retrying.
