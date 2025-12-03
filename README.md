# Atenxion Post-Login Sync Integration

This project now triggers Atenxion's background synchronization as part of the HR Connect login flow. After a user authenticates successfully, the browser immediately queues a non-blocking POST request to Atenxion QA so that the portal can stay responsive while downstream systems synchronize.

## How it works

- The login form in [`public/index.html`](public/index.html) submits to the local `/login` endpoint handled by the Node.js server (`server.js`).
- When authentication succeeds, [`public/index.js`](public/index.js) stores the session token and user object in `localStorage`, then calls `queuePostLoginSync(user.employeeId)` without awaiting it. The UI transitions instantly to the main app.
- `queuePostLoginSync` (also in `public/index.js`) sends `{"employeeId":"<employeeId>"}` to `https://api-qa.atenxion.ai/integrations/hr/post-login-sync` with a five-second timeout. Errors are logged to the console only.
- If `fetch` is unavailable or the request times out, the code falls back to `navigator.sendBeacon` with the same JSON payload to keep the sync fire-and-forget.
- Microsoft 365 SSO logins also trigger the same sync immediately after their redirect completes.

## Running the portal locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 to access the HR portal. The built-in credentials and endpoints remain unchanged; the only addition is the background Atenxion sync that fires after a successful login.

## Migrating leave system data

Run the migration script to backfill leave balance metadata for all employees. The migration no longer runs automatically when the server starts, so execute it manually whenever you need to normalize leave balances:

```bash
node scripts/migrateLeaveSystem.js
```

## Security note

For demo purposes the Atenxion bearer token is embedded directly in the client-side code. In production you should proxy this request through your backend or use another secure relay so the token is not exposed to end users.
