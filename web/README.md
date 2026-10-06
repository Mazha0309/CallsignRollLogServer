# Callsign Roll Log Server WebUI

React + Ant Design portal for the authenticated member workspace (`/app`) and
server administration console (`/admin`). The app uses an in-memory access
token and an HttpOnly refresh cookie through `/api/v1/web-auth/*`.

```bash
npm install
npm run dev
npm run lint
npm run build
```

The development server proxies `/api` to `http://localhost:3000`.
Production refresh cookies are `Secure`; expose the portal through HTTPS (or a
browser-recognized localhost development origin), not plaintext LAN HTTP.

## Authentication contract

- Access tokens live only in JavaScript memory.
- `/api/v1/web-auth/refresh` rotates an HttpOnly, SameSite refresh cookie.
- Concurrent `401` responses share one refresh request; tabs coordinate through
  the Web Locks API when available, and a freshly rotated cookie is retried once
  using the server-provided delay.
- Web authentication sends a stable browser device ID so rotated credentials
  remain one revocable device-session family.
- `PASSWORD_CHANGE_REQUIRED` is completed with a short-lived password-change
  token before an access token is issued.
- Administrator elevation tokens live only in memory and are attached for at
  most five minutes to governance requests.

The public Liveshare remains a separate bundle and must never share this
authenticated client's token or cookie state.

## Public archive workspace

The authenticated member workspace at `/app/public-archives` manages static
public archive lists made from closed personal or collaboration sessions. An
owner or list member can edit titles, publish/unpublish, add and remove copied
sessions, refresh a snapshot explicitly, and reorder content. Only the owner or
an administrator can manage list members and source accounts.

Administrators also have `/admin/public-archives`, where they can inspect all
lists and create, replace, or delete root aliases. An alias produces public
links such as `/BR5AI` and `/BR5AI/session/:archiveSessionId`; the internal
member link is `/live/list/:listId`. Archive pages are tokenless and do not use
the authenticated access token, refresh cookie, LiveShare WebSocket, or
LiveShare visitor tracking.

## Account session sharing

The member workspace at `/app/sharing` manages request-based account-to-account
session sharing: inbox/outbox, accept/reject, and the read-only shared session
catalog. Joining a grantor's owned collaboration session still requires that
session's passphrase.
