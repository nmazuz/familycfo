# Category mapper (n8n)

Import `category-mapper.json` into n8n. It is an inactive, sanitized copy of the category-mapping workflow: Webhook → Edit Fields → Gemini LLM chain → Respond to Webhook.

1. Select your own Google Gemini credentials on **Google Gemini Chat Model1**. No credentials or credential identifiers are included in the export.
2. Activate the workflow and copy its production webhook URL (path: `category`).
3. In FamilyCFO Settings set the category API URL to that webhook, or set `categoryApiUrl` in the ignored `accounts.json`.
4. Test with a synthetic request: `{"description":"סופרמרקט לדוגמה"}`. The app accepts n8n's text response and maps it to an existing category. Optional `amount`, `direction` and `categoriesText` inputs are supported by the workflow; the current app sends only `description`.

The export contains no pinned execution data, credential references, webhook deployment IDs, workspace/instance metadata, workflow/version IDs or account tags. The category list and classification instructions are generic. Your original file is untouched. Classification sends transaction descriptions to your n8n server and to Gemini; choose the endpoint accordingly.
