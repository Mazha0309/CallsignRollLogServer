# Callsign Roll Log Secure Live Share

The public, read-only Live Share client for collaboration protocol v1.

It contains two public, read-only modes. LiveShare is capability-based and
realtime:

```text
/live/{publicShareId}#token={secret}
```

The `#token=...` fragment remains visible in the address bar and is never
stored. The client keeps it only in memory, exchanges it for a short-lived
public token, fetches a full public snapshot, then connects to `/ws/public`
with a one-time ticket. WebSocket data is accepted only in
`hello -> backlog -> ready -> live` order; a sequence gap triggers a new
snapshot.

Static archives are a separate tokenless mode:

```text
/live/list/:listId
/live/list/:listId/session/:archiveSessionId
/:alias
/:alias/session/:archiveSessionId
```

Archive pages read copied snapshots once through the anonymous archive API.
They use no LiveShare token, cookies, WebSocket, polling, or LiveShare visitor
analytics. Root alias pages are served by the server only for published admin
aliases; `/live/list/...` uses the internal list ID.

Only LiveShare sends a random anonymous view-session ID during exchange.
The server stores only its share-scoped HMAC and, from database migration v24,
the latest trusted request IP for administrator statistics. It does not store the
raw page ID or User-Agent. See
[`Public Live Share Statistics API v1`](../docs/public-liveshare-statistics-api-v1.md)
for the response schema, retention limits, and `TRUST_PROXY` requirements.

```bash
npm run dev
npm run lint
npm run build
```

The Express server must mount `dist` at `/live` with an SPA fallback to `dist/index.html`. Vite's production asset base is `/live/`.
