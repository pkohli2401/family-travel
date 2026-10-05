# Family Travel Log

Standalone family trip tracker (flights, stays, dining, suggestions).

- `public/` static app (installable on phone/iPad), sign-in by emailed link
- `supabase/schema.sql` tables, row level security, family allowlist
- `api/mcp.js` connector so Claude chats can add suggestions and bookings
- `api/sync.js` daily TripIt feed sync (Vercel cron)

## Environment variables (Vercel)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (secret)
- `MCP_KEY` (long random string; part of the connector URL)
- `CRON_SECRET` (long random string for the daily sync)

Public values (Supabase URL and anon key) go in `public/config.js`.
