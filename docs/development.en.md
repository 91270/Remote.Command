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

### 3.1 Install `cloudflared`

- **macOS**:
  - If Homebrew provides bottles for your macOS version: `brew install cloudflared`
  - If Homebrew attempts a source build of Go (e.g. unsupported macOS bottle), install the official prebuilt macOS release tarball from [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases) into `~/.local/bin/cloudflared` (ensure `~/.local/bin` is on `PATH`):

```bash
# Example for macOS x86_64 (amd64); replace with arm64 on Apple Silicon
tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz -o "$tmp/cloudflared.tgz"
tar -xzf "$tmp/cloudflared.tgz" -C "$tmp"
install -d -m 0755 "$HOME/.local/bin"
install -m 0755 "$tmp/cloudflared" "$HOME/.local/bin/cloudflared"
cloudflared --version
```

- **Linux**: Follow the [official Cloudflare downloads guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and verify `cloudflared --version`.

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

### 5.1 Create `state/local-test.env` (Gitignored)

Create a private configuration file under `state/`:

```bash
install -d -m 0700 state
umask 077 && cat > state/local-test.env <<'EOF'
# Local test environment (ignored by .gitignore — never commit to Git)
PUBLIC_ORIGIN="https://dev-mcp.example.com"
BIND_HOST="127.0.0.1"
PORT="8787"
TRUST_PROXY="1"
STATE_DB="./state/local-test.sqlite"

# From Google Cloud Console -> Clients (Web application)
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret"

# Recommended: lock initial admin registration to your own Google email(s)
ADMIN_GOOGLE_EMAILS="owner@example.com"

# Tunnel token from Cloudflare Zero Trust Dashboard
CLOUDFLARED_TUNNEL_TOKEN="your-tunnel-token"

# Uncomment if local Node.js needs an HTTP proxy to reach accounts.google.com
# NODE_USE_ENV_PROXY="1"
# HTTPS_PROXY="http://127.0.0.1:7890"
EOF
```

<details>
<summary>Plan B (Plaintext Loopback) Override</summary>

Set `PUBLIC_ORIGIN="http://127.0.0.1:8787"`, add `ALLOW_INSECURE_LOOPBACK="1"`, set `TRUST_PROXY="0"`, leave `CLOUDFLARED_TUNNEL_TOKEN` empty, and run the Gateway directly (ensure your OAuth client permits loopback redirects and always open `http://127.0.0.1:8787/manage`, not `localhost`).

</details>

### 5.2 Start in Two Terminals

```bash
# Terminal 1: Start Cloudflare Tunnel (passed via env var so the token stays out of `ps` args)
set -a && source state/local-test.env && set +a
env TUNNEL_TOKEN="$CLOUDFLARED_TUNNEL_TOKEN" cloudflared tunnel run

# Terminal 2: Start local Gateway (strip tunnel token from Gateway env)
set -a && source state/local-test.env && set +a
env -u CLOUDFLARED_TUNNEL_TOKEN -u TUNNEL_TOKEN node dist/gateway.js
```

### 5.3 Combined Quick-Start Wrapper (Optional)

Save the following script to `state/start-local-test.sh` (also ignored by `.gitignore`) and make it executable (`chmod 0700 state/start-local-test.sh`):

```bash
#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/state/local-test.env"
export PATH="$HOME/.local/bin:$PATH"

MODE="${1:-all}"
if [ "$MODE" = "-h" ] || [ "$MODE" = "--help" ]; then
  echo "Usage: ./state/start-local-test.sh [all|tunnel|gateway]"
  exit 0
fi

set -a
source "$ENV_FILE"
set +a

if [ ! -f "$ROOT_DIR/dist/gateway.js" ]; then
  (cd "$ROOT_DIR" && npm run build)
fi

TUNNEL_PID=""
cleanup() {
  if [ -n "${TUNNEL_PID:-}" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}

case "$MODE" in
  tunnel)
    exec env TUNNEL_TOKEN="$CLOUDFLARED_TUNNEL_TOKEN" cloudflared tunnel run
    ;;
  gateway)
    cd "$ROOT_DIR"
    exec env -u CLOUDFLARED_TUNNEL_TOKEN -u TUNNEL_TOKEN node dist/gateway.js
    ;;
  all)
    trap cleanup INT TERM EXIT
    env TUNNEL_TOKEN="$CLOUDFLARED_TUNNEL_TOKEN" cloudflared tunnel run &
    TUNNEL_PID=$!
    cd "$ROOT_DIR"
    env -u CLOUDFLARED_TUNNEL_TOKEN -u TUNNEL_TOKEN node dist/gateway.js
    ;;
  *)
    echo "Unknown subcommand: $MODE" >&2
    exit 2
    ;;
esac
```

Run `./state/start-local-test.sh` to start both processes together; press `Ctrl+C` to stop both cleanly.

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
