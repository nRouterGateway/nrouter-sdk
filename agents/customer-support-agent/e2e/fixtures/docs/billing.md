---
title: Billing and Credits
---

# Billing and Credits in Northwind Notes

Northwind Notes operates on a usage-based credit model for workspace storage, automated indexing, and AI query assistance.

## Workspace Credits

Every Northwind Notes organization maintains a central credit balance. Operations consume credits based on resource utilization and request complexity. You can monitor credit consumption and balances in real time from the admin dashboard.

## Credit Top-ups

Organizations can top up credits at any time:
- **Manual Top-up**: Navigate to **Billing → Add Credits** in the management console to purchase one-time credit bundles via credit card or invoice.
- **Auto-recharge**: Enable automatic top-ups under **Billing → Auto-recharge** to automatically replenish credits whenever your organization balance falls below a configured threshold.

## Zero Balance Behavior

When your organization reaches a zero balance:
- All incoming API requests are rejected immediately with an HTTP `402 Payment Required` status code.
- Workspace document search and background knowledge indexing are temporarily paused until credits are replenished.
- No documents or notes are lost, and all workspace services resume immediately once a credit top-up completes.
