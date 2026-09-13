---
title: Getting Started with Northwind Notes
---

# Getting Started with Northwind Notes

Welcome to Northwind Notes, the collaborative documentation and knowledge management workspace.

## Creating an API Key

To access the Northwind Notes developer API or configure automated integrations, you must create an API key:

1. Sign in to your Northwind Notes workspace account.
2. In the navigation sidebar, navigate to **Settings → API keys**.
3. Click **Create API Key**.
4. Enter a name for the key and choose the appropriate access permissions (read-only or full access).
5. Copy the generated API key immediately. For security reasons, the full secret key is never displayed again after creation.

Include your API key as a Bearer token in the `Authorization` header on all API requests:

```
Authorization: Bearer <your-api-key>
```
