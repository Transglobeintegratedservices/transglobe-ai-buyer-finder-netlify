# Transglobe AI Buyer Finder V2

A Node.js web application for online client discovery, evidence-backed lead qualification, prospect tracking, follow-ups and outreach drafting. It upgrades the original front-end prototype with a server API, central JSON storage, live search integration, optional AI analysis, scheduled discovery and basic access-token support.

## What works in this package

- Responsive dashboard, live-discovery page, prospect pipeline, follow-up queue and outreach draft assistant.
- Server-side prospect CRUD and archiving, saved in `data/leads.json`.
- Live web search integration using LangSearch's free Web Search API (requires a free `LANGSEARCH_API_KEY`). Optional legacy SerpApi support remains available.
- Rules-based relevance/intent classification and lead scoring; optional OpenAI analysis if `OPENAI_API_KEY` is configured.
- Duplicate filtering using canonical source URLs.
- Scheduled searches every six hours when the search key is configured and the server remains running.
- CSV export, source links, status tracking, and connection/health checks.
- Optional `APP_TOKEN` gate for API requests.
- Automated tests for classification, URL validation and query generation.

## Requirements

- Node.js 20 or newer.
- A free LangSearch API key for live online search. LangSearch has a daily token allowance and rate limits; it does not require a paid search subscription. An optional SerpApi key can be used as a legacy alternative.
- Optional OpenAI API key for AI-assisted classification. Deterministic rules still work without it.

## Run locally

1. Extract the ZIP.
2. Copy `.env.example` to `.env`.
3. Get a free key from the official [LangSearch API keys page](https://langsearch.com/api-keys) and add `LANGSEARCH_API_KEY=your_key` to `.env`. Optionally set `OPENAI_API_KEY` and a strong `APP_TOKEN`. Keep the key server-side; never put it in `index.html`.
4. Keep `HOST=127.0.0.1` for local use. Do not expose the app publicly without HTTPS, a strong token, and appropriate hosting/security controls.
5. Run `npm start` (or `node server.js`).
6. Open `http://127.0.0.1:8787`.
7. If `APP_TOKEN` is set, enter the same token under Settings & connection.
8. Select services and click **Run discovery now**. Review the source evidence and verify leads before contacting them.

No API keys are included in this ZIP. Live search cannot return real online results until you supply a valid search key. The app reports missing configuration rather than fabricating results.

## Tests

Run `npm test`. The test suite uses Node's built-in test runner and requires no extra packages.

## Scheduling behaviour

With a valid `LANGSEARCH_API_KEY` (or optional legacy `SERPAPI_KEY`), a scheduled search runs every `SEARCH_INTERVAL_HOURS` (default 6 hours) after the server starts. The first scheduled run happens after one interval; click **Run discovery now** to perform the first run immediately. The server must remain online for scheduled searches. For a cloud host, use a persistent Node service or a supported scheduler that invokes the discovery endpoint securely.

## API endpoints

- `GET /api/health` — reports readiness without exposing secrets.
- `GET /api/leads` — active leads.
- `POST /api/leads` — create a lead.
- `PATCH /api/leads/:id` — update a lead.
- `DELETE /api/leads/:id` — archive a lead.
- `POST /api/discover` — run live discovery.
- `GET /api/run-status` — last discovery run and error summary.

If `APP_TOKEN` is configured, API calls except the health check require the `X-App-Token` header.

## Important production notes

- This is a deployable starter, not a hosted service. You must configure API credentials and deploy it to a server that remains online.
- JSON-file storage is suitable for a small single-instance start; use a managed database for multi-user or production-scale deployment.
- The search engine returns public search results, not proof of buying intent. Every lead includes its source and must be verified.
- Automated outreach is intentionally not enabled. The app drafts messages for human review.
- Search result volume, freshness, costs and coverage depend on the search provider and its terms. The app cannot guarantee a buyer will be found in every run.
- The optional AI provider may be unavailable or may return unusable output; rules-based classification remains as fallback.
- Before internet-facing deployment, add HTTPS, stronger authentication/rate limiting, database backups, privacy review and monitoring.


## Netlify deployment (backend adapter included)

This ZIP includes `netlify.toml` and `netlify/functions/api.js`. The frontend routes API calls through the Netlify Function, which reads `LANGSEARCH_API_KEY` from the server-side environment. In Netlify, deploy the **contents of this folder** (the folder containing `index.html` and `netlify.toml`) as the site root, with Functions scope enabled for the variable. After deployment, test `/.netlify/functions/api?path=%2Fapi%2Fhealth`; it should return JSON and report `searchConfigured: true`. Then run a discovery search in the app.

**Storage limitation:** this first Netlify adapter keeps prospect records in function memory, which is temporary and may reset between invocations. Do not rely on it as permanent lead storage; a managed database or Netlify Blobs integration is required for durable prospect records. The adapter does not claim scheduled discovery is active on Netlify.
