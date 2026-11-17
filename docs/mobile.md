# Mobile access

Install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/) on the computer (macOS: `brew install cloudflared`). In the desktop app, open **הגדרות → חיבור לנייד → הפעל חיבור לנייד**. From source run `npm run mobile`, then open `http://127.0.0.1:4310` and use the same settings panel. `npm run dev` does not serve a production web build and cannot start mobile access.

Scan the QR code using your phone camera (or open the displayed HTTPS address), then enter the separate six-digit access code. The QR is generated locally and contains only the address. Both reading and editing are available. The connection expires after 12 hours and stops when you disconnect it or close the app. Starting it again generates a new code and session. Keep the computer awake and connected. The app does not install or start cloudflared until you explicitly enable the connection. `CLOUDFLARED_PATH` can point to its executable.

The public tunnel connects to a **separate authenticated loopback gateway**; do not point a tunnel directly at the unauthenticated API or Vite. The gateway requires a cryptographically random six-digit pairing code, limits login attempts to five per minute and locks pairing after 20 wrong codes until the connection is restarted on the computer, and uses a Secure/HttpOnly/SameSite cookie. It checks Host/Origin, expires sessions on the server, and blocks access to tunnel controls from the phone. Codes and session secrets live only in memory. Financial data travels through Cloudflare while the connection is enabled.

## Temporary connection

The default is a [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) with a random address. It has no uptime guarantee and does not support SSE, so the data chat is unavailable over this connection. Other screens, edits, scanning progress and OTP submission use ordinary HTTP requests.

## Stable address and chat (Named Tunnel)

For a stable hostname and SSE support, create a remotely managed Cloudflare Tunnel and configure its published HTTPS hostname to route to **`http://127.0.0.1:4311`**, the authenticated gateway. Do not route to ports 4310/4330/4331 or to Vite. Leave HTTP Host Header unset so the gateway receives the public hostname. Optional Cloudflare Access can protect the hostname as an additional layer.

Launch the app/server with:

- `CLOUDFLARED_TUNNEL_TOKEN`: the tunnel token (kept in the process environment, never passed on the command line or returned by the API).
- `MOBILE_PUBLIC_URL`: e.g. `https://finance.example.com`.
- `MOBILE_GATEWAY_PORT`: optional, defaults to `4311`; update the Cloudflare origin if you change it.

Then activate mobile access in Settings. The access code, 12-hour expiry and disconnect button apply in this mode too. Store tunnel tokens outside the repository. The app starts its own connector; avoid running an additional connector to the same local origin independently.
