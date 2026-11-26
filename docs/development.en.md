[中文](development.md) · [English](development.en.md)

# Remote.Command Development & Local End-to-End Setup Guide

This guide walks developers and self-hosters through setting up a full local test environment covering **Gateway + Google OIDC + Local Agent + ChatGPT Remote MCP**.

> [!NOTE]
> Keep all secret environment files, test databases, and local helper scripts inside the `.gitignore`-excluded `state/` directory. Never commit real `GOOGLE_CLIENT_SECRET` values, tunnel tokens, or SQLite files to Git.

---

## 1. Prerequisites & Build

In the repository root, verify the runtime and compile TypeScript outputs:

- **Node.js**: 24–26
- **npm** and **Git**
- Install dependencies and build:

```bash
npm ci --include=dev --ignore-scripts
npm run build
```

Run the automated test suite when needed:

```bash
# Unit and end-to-end tests
npm test

# macOS / Linux: include real TLS and interactive TTY approval checks (requires OpenSSL and Python 3)
RCM_TEST_TLS=1 RCM_TEST_TTY=1 npm test
```

---

## 2. Choose a Local Access Mode

The Gateway enforces strict checks on `PUBLIC_ORIGIN` (see [protocol.ts](../src/protocol.ts)):

- Only **`https://`** origins are allowed by default.
- Plaintext **`http://127.0.0.1:<port>`** is permitted only when `ALLOW_INSECURE_LOOPBACK=1` is explicitly set (`http://localhost:<port>` is **not** accepted).

Meanwhile, Google Cloud Console **Web application** OAuth clients often require a domain name or `localhost` for redirect URIs and may reject bare `127.0.0.1`. Choose one of the two modes below:

| Mode | Best For | Notes |
| --- | --- | --- |
| **Plan A: Local Gateway + HTTPS Tunnel (Recommended)** | Full-stack testing with Google login, local Agent, and **ChatGPT Remote MCP** | Maps a fixed test subdomain (e.g. `https://dev-mcp.example.com`) through Cloudflare Tunnel to `127.0.0.1:8787`, satisfying HTTPS validation, Google Web OAuth redirect checks, and ChatGPT's public HTTPS requirement. |
| **Plan B: Plaintext Loopback `http://127.0.0.1:8787`** | Offline/local UI & API checks without ChatGPT | Requires `ALLOW_INSECURE_LOOPBACK=1`, opening the browser strictly via `127.0.0.1` (never `localhost`, or the OIDC state cookie will fail), and setting `"allowInsecureLoopback": true` in the local Agent config. |

> [!TIP]
> You only need **1 Cloudflare Tunnel** and **1 subdomain** (such as `dev-mcp.example.com`). The dashboard (`/manage`), Google OIDC callback (`/auth/google/callback`), ChatGPT MCP endpoint (`/mcp`), and Agent sync routes (`/agent/*`) all share that single origin and local port.

The steps below follow **Plan A**; Plan B overrides are noted inline.

---

## 3. Step 1: Install `cloudflared` and Create a Cloudflare Tunnel

### 3.1 Install `cloudflared` (Windows / macOS / Linux)

The repository ships a cross-platform helper [scripts/dev-local.mjs](../scripts/dev-local.mjs) with thin wrappers ([scripts/dev-local.sh](../scripts/dev-local.sh) and [scripts/dev-local.ps1](../scripts/dev-local.ps1)) that automatically downloads official prebuilt `cloudflared` binaries for **Windows (`amd64` / `386`), macOS (`amd64` / `arm64`), and Linux (`amd64` / `arm64`)** into `~/.local/bin/cloudflared` (`%USERPROFILE%\.local\bin\cloudflared.exe` on Windows):

- **macOS / Linux**:
  ```bash
  ./scripts/dev-local.sh install-tunnel
  # Force-upgrade later: ./scripts/dev-local.sh install-tunnel --force
  ```
- **Windows (PowerShell)**:
  ```powershell
  .\scripts\dev-local.ps1 install-tunnel
  # Force-upgrade later: .\scripts\dev-local.ps1 install-tunnel --force
  ```

> [!TIP]
> Running the launcher for `all` or `tunnel` also auto-installs `cloudflared` if it is not already installed. Manual downloads remain available from [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases).

### 3.2 Create the Tunnel in Cloudflare Zero Trust

1. Sign in to the [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Go to **Networks** → **Tunnels** → **Create a tunnel** and choose **Cloudflared**.
3. Name the tunnel (e.g. `rcm-dev`), save it, and copy the **Tunnel Token** (for `CLOUDFLARED_TUNNEL_TOKEN`).
4. Add **1 Public Hostname** rule:
   - **Subdomain**: `dev-mcp`
   - **Domain**: your Cloudflare-managed domain (e.g. `example.com`)
   - **Path**: **leave empty** so `/manage`, `/auth/google/callback`, `/mcp`, `/oauth/*`, and `/agent/*` all forward through
   - **Service Type**: `HTTP`
   - **URL**: `127.0.0.1:8787`

---

## 4. Step 2: Configure Google Cloud Console (Google Auth Platform)

1. **Select or create a project**: In [Google Cloud Console](https://console.cloud.google.com/), pick an existing project or create a dedicated dev project (e.g. `remote-command-dev`).
2. **Initialize Google Auth Platform**:
   - Direct link: https://console.cloud.google.com/auth (or **APIs & Services → OAuth consent screen**).
   - Click **Get started** on first setup and fill in the 4 steps:
     1. **App Information**: Set App name to `Remote.Command Dev` and select your support email.
     2. **Audience**: Choose **External**. Leave publishing status in **Testing**—no Google verification review is required for personal/test-user logins.
     3. **Contact Information**: Enter your email address.
     4. **Finish**: Accept the policy and create.
3. **Add Test Users (Required)**:
   - Open **Audience** (https://console.cloud.google.com/auth/audience).
   - Under **Test users**, click **+ Add users**, add every Gmail address you plan to test with, and save.
   - If you want to test multi-tenant invite-code registration, add the second test Gmail account here as well.
4. **Create the OAuth Web Client**:
   - Open **Clients** (https://console.cloud.google.com/auth/clients).
   - Click **+ Create client**:
     - **Application type**: **Web application**
     - **Name**: `Remote.Command Dev`
     - **Authorized redirect URIs**: Paste the exact callback URL (no trailing slash):
       ```text
       https://dev-mcp.example.com/auth/google/callback
       ```
   - Save and record the generated **`Client ID`** and **`Client Secret`**.

> [!IMPORTANT]
> Remote.Command requests only basic scopes (`openid email profile`). The redirect URI in Google Cloud Console must match `PUBLIC_ORIGIN + "/auth/google/callback"` character for character, or Google will reject logins with `Error 400: redirect_uri_mismatch`.

---

## 5. Step 3: Local Environment & Quick-Start Script

### 5.1 Copy the Sanitized Template to `state/local-test.env`

Copy the tracked template [local-test.env.example](../local-test.env.example) into the `.gitignore`-excluded `state/` directory:

- **macOS / Linux**:
  ```bash
  install -d -m 0700 state
  cp local-test.env.example state/local-test.env
  chmod 600 state/local-test.env
  ```
- **Windows (PowerShell)**:
  ```powershell
  New-Item -ItemType Directory -Force state | Out-Null
  Copy-Item local-test.env.example state\local-test.env
  ```

Edit `state/local-test.env` with your local values:

- `PUBLIC_ORIGIN`: e.g. `"https://dev-mcp.example.com"` (must match both Google redirect URI and Cloudflare Public Hostname)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: credentials from Google Cloud Console
- `ADMIN_GOOGLE_EMAILS`: your admin Google email address
- `CLOUDFLARED_TUNNEL_TOKEN`: Tunnel token from Cloudflare Zero Trust Dashboard
- If local Node.js needs an HTTP proxy to reach `accounts.google.com`, uncomment `NODE_USE_ENV_PROXY="1"` and `HTTPS_PROXY`

<details>
<summary>Plan B (Plaintext Loopback) Override</summary>

Set `PUBLIC_ORIGIN="http://127.0.0.1:8787"`, add `ALLOW_INSECURE_LOOPBACK="1"`, set `TRUST_PROXY="0"`, leave `CLOUDFLARED_TUNNEL_TOKEN` empty, and run the `gateway` subcommand (ensure your OAuth client permits loopback redirects and always open `http://127.0.0.1:8787/manage`, not `localhost`).

</details>

### 5.2 Start with the Cross-Platform Helper Script

- **macOS / Linux**:
  ```bash
  # Install cloudflared standalone (also auto-runs when starting all/tunnel)
  ./scripts/dev-local.sh install-tunnel

  # Start both Cloudflare Tunnel and local Gateway together (Ctrl+C stops both)
  ./scripts/dev-local.sh

  # Or run in separate terminals:
  ./scripts/dev-local.sh tunnel
  ./scripts/dev-local.sh gateway
  ```
- **Windows (PowerShell)**:
  ```powershell
  # Install cloudflared standalone (also auto-runs when starting all/tunnel)
  .\scripts\dev-local.ps1 install-tunnel

  # Start both Cloudflare Tunnel and local Gateway together (Ctrl+C stops both)
  .\scripts\dev-local.ps1

  # Or run in separate terminals:
  .\scripts\dev-local.ps1 tunnel
  .\scripts\dev-local.ps1 gateway
  ```

> Security note: the script passes `TUNNEL_TOKEN` via environment variable to `cloudflared` (keeping it out of process command-line arguments) and strips tunnel token variables before starting `node dist/gateway.js`. If `dist/gateway.js` is missing, `npm run build` runs automatically.

---

## 6. Step 4: End-to-End Verification Checklist

1. **Health & Discovery Endpoints**:
   - Check `https://dev-mcp.example.com/readyz` returns `200`.
   - Check `https://dev-mcp.example.com/.well-known/oauth-protected-resource/mcp` reports `"resource": "https://dev-mcp.example.com/mcp"`.
2. **First Admin Google Login**:
   - Open `https://dev-mcp.example.com/manage` and click **Continue with Google**.
   - After consent, verify you land on the dashboard with `admin` role.
3. **Multi-Tenant & Registration Modes (Optional)**:
   - Under **Members & Invites**, switch registration modes (`invite` / `open` / `closed`), create an invite code, and sign in with a second test Gmail account to verify strict per-user device isolation.
4. **Local Agent Pairing**:
   - Create a dedicated test workspace separate from `$HOME`, filesystem root, or the repository itself (see [agent-config.ts](../src/agent-config.ts)):

```bash
mkdir -p /tmp/rcm-test-workspace
node dist/remote-cli.js remote \
  --config "$HOME/.remote-command/agent-local-test.json" \
  --gateway "https://dev-mcp.example.com" \
  --workspace "/tmp/rcm-test-workspace" \
  --allow "read,write,exec"
```

   - For Plan B (`http://127.0.0.1:8787`), write the JSON file manually with `"allowInsecureLoopback": true` and a `0700` `stateDir` before running `node dist/remote-cli.js remote --config <path>`.
5. **ChatGPT Remote MCP Integration**:
   - Add MCP Server URL `https://dev-mcp.example.com/mcp` in ChatGPT with **OAuth** authentication (Dynamic Client Registration at `/oauth/register` works automatically—no static client credentials needed).
   - Confirm authorization on `/oauth/authorize` using your active Google session, then test `who_am_i`, `list_devices`, and an approval-gated tool call.

---

## 7. Troubleshooting

| Symptom | Likely Cause | Resolution |
| --- | --- | --- |
| Google displays `403 access_denied` | App is in Testing mode and the email is not in Test users | Add the Gmail address under **Audience → Test users** in Google Cloud Console |
| Google displays `400 redirect_uri_mismatch` | Trailing slash, scheme, or hostname mismatch against `PUBLIC_ORIGIN` | Ensure Console has exact `https://<host>/auth/google/callback` and `PUBLIC_ORIGIN` has no trailing `/` |
| Callback returns `502` exchanging token | Local Node.js cannot reach `accounts.google.com` / `oauth2.googleapis.com` directly | Set `NODE_USE_ENV_PROXY="1"` and `HTTPS_PROXY` in `state/local-test.env` |
| Callback says OIDC state invalid / expired | Mixing `localhost` and `127.0.0.1` in Plan B so the state cookie is not sent | Use `http://127.0.0.1:<PORT>` consistently in Plan B, or use a fixed domain in Plan A |
| `Gateway startup aborted: missing required Google OAuth...` | Env file not sourced or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` blank | Fill both variables and source with `set -a && source ... && set +a` |
| Agent rejects workspace/state paths | Workspace is `$HOME`, `/`, or overlaps config, install dir, or `stateDir` | Use a standalone folder like `/tmp/rcm-test-workspace` and keep config/state outside it |
