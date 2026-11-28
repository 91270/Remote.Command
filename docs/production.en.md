[中文](production.md) · [English](production.en.md)

# Remote.Command Production Deployment & Operations Guide

This guide covers single-instance and multi-tenant production deployment, including **initial Gateway setup (Google OIDC + Docker Compose + HTTPS), offline image loading, upgrades & rollbacks, release packaging, Agent background services, online backup & restore drills, and routine operations**. For local development setup, see the [Development Setup Guide](development.en.md).

> [!NOTE]
> A host-level Nginx (or equivalent TLS-terminating reverse proxy) serves your public HTTPS domain and forwards traffic to the Gateway container on port `8787`. SQLite state and rotated logs persist on the host directory mapped by Compose `volumes.source` (default `./data`).

---

## 1. Initial Deployment

### 1.1 Architecture & Prerequisites

Prepare a Linux server with **Docker Engine / Docker Compose** and **Nginx** (or an equivalent HTTPS reverse proxy):

- Point a dedicated production domain (such as `mcp.example.com`, separate from any dev/staging subdomain) to this server.
- Provision valid TLS certificates for Nginx (for example via Let's Encrypt) so all public traffic enters over HTTPS `443`.

### 1.2 Configure Production Google OAuth 2.0

The Gateway exclusively authenticates users via **Google OIDC** (no local passwords exist). Prepare Google OAuth credentials before starting the container:

1. Open **Google Auth Platform** in [Google Cloud Console](https://console.cloud.google.com/auth).
   - **Recommended**: Create a separate **Web application** OAuth client dedicated to production rather than sharing credentials with local dev.
2. Under **Clients → Create client (Web application)**, set:
   - **Authorized redirect URIs**: Paste the exact callback URL (no trailing slash):
     ```text
     https://mcp.example.com/auth/google/callback
     ```
3. Record the generated **`Client ID`** and **`Client Secret`**.
4. **Audience / Publishing Status**:
   - **Personal or small invite-only team**: Keep the app in **Testing** and add allowed Gmail addresses under **Test users** (no Google review needed).
   - **Public access for any Google account**: Complete **Branding** (app info, authorized domain, privacy/terms URLs) and publish the app **In Production**. Remote.Command only requests non-sensitive scopes (`openid email profile`).

### 1.3 Prepare Deployment Directory, Secrets & Start Gateway

1. Create a deployment directory on the server and place [compose.yaml](../compose.yaml) there (or download `remote-command-<version>-compose.yaml` from a GitHub Release and save it as `compose.yaml`). If your GHCR package is private, authenticate with `docker login ghcr.io` using a token with `read:packages`.

2. Copy [deploy/production.env.example](../deploy/production.env.example) to `.env` beside `compose.yaml` and restrict permissions (automatically read by Docker Compose; **never hardcode real secrets into tracked YAML files or commit `.env` to Git**):

```sh
cp deploy/production.env.example .env && chmod 600 .env
# Edit .env with your production PUBLIC_ORIGIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_GOOGLE_EMAILS, and TRUST_PROXY=1
```

   - **`ADMIN_GOOGLE_EMAILS` (strongly recommended)**: Comma-separated list of Google emails allowed to claim the initial admin role on an empty database. If left empty, the very first Google user to sign in becomes admin.
   - **`TRUST_PROXY=1`**: Enable when running behind Nginx or another trusted reverse proxy so rate limiters inspect `X-Forwarded-For` / `X-Real-IP`.
   - **Port binding hardening**: Default `compose.yaml` maps `"8787:8787"`. If host Nginx proxies local traffic, tighten it to `"127.0.0.1:8787:8787"` so port `8787` is not exposed directly to the public internet.
   - **OAuth DCR**: ChatGPT and Codex automatically register via `/.well-known/oauth-*` and `/oauth/register`; no static `OAUTH_CLIENT_ID` or `OAUTH_REDIRECT_URIS` are required.

3. Prepare the host data directory. The Gateway container runs as UID/GID `1000:1000` and needs write access:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 ./data
```

4. Start the Gateway container (initializes `data/gateway.sqlite` and internal credential files such as `data/.owner_key` with mode `0600`, preserved across container recreations):

```sh
docker compose up -d --wait
```

   Inspect startup logs to verify environment loading and readiness:

```sh
docker compose logs --tail 50 gateway
```

### 1.4 Configure Host Nginx & HTTPS

1. Copy [remote-command.conf](../deploy/nginx/remote-command.conf) into your enabled Nginx site directory (e.g. `/etc/nginx/conf.d/remote-command.conf`) and update `server_name`, `ssl_certificate`, and `ssl_certificate_key` for your domain.
2. Key settings preserved in the template:
   - `client_max_body_size 40m;`: matches the Gateway's 40 MiB sync body limit.
   - `proxy_buffering off;`, `proxy_cache off;`, `proxy_read_timeout 65s;`: prevents buffering MCP streaming responses and keeps 25s `/device/sync` HTTP Long Polling connections from timing out prematurely.
   - Forwards `Host`, `X-Forwarded-Proto`, `X-Forwarded-For`, and `X-Real-IP`.
3. **Control panels (e.g. aaPanel / BT Panel)**: If a generic `location ~ \.well-known` static rule exists, it will intercept OAuth discovery requests with 404. Add a priority prefix block before it:

```nginx
location ^~ /.well-known/acme-challenge/ { allow all; }
location ^~ /.well-known/oauth- {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

4. Test and reload Nginx:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

### 1.5 Initial Sign-In & Production Verification

1. Verify local and public endpoints:
   - Host: `curl -fsS http://127.0.0.1:8787/readyz`
   - Public client: `curl -fsS https://mcp.example.com/readyz`
   - Confirm `https://mcp.example.com/.well-known/oauth-protected-resource/mcp` returns `"resource": "https://mcp.example.com/mcp"`.
2. **Claim initial admin account**: Open `https://mcp.example.com/manage` in your browser, click **Continue with Google**, and sign in with an email listed in `ADMIN_GOOGLE_EMAILS`.
3. **Set registration policy**: Under **Members & Invites**, confirm the new-user registration mode (`invite` by default for invite-code activation, `closed`, or `open`).
4. **Pair Devices & Connect ChatGPT**: Install the matching Agent version on your target machine per [README Quick Start](../README.md) and connect ChatGPT to `https://mcp.example.com/mcp` using OAuth.

---

## 2. Offline Images & Building from Source

### Using an Offline Image Tarball

Load the `linux/amd64` archive and update `image:` in `compose.yaml` to match the loaded tag:

```sh
docker image load -i remote-command-<version>-gateway-linux-amd64.tar.gz
docker compose up -d --pull never --wait
```

### Building Directly from Source

Maintainers can build the Gateway image from the repository root and set `image: remote-command:local` in Compose:

```sh
docker build -t remote-command:local .
docker compose up -d --pull never --wait
```

---

## 3. Upgrades & Rollbacks

1. **Back up first**: Take and verify an online SQLite backup (Section 6), and keep the previous image tag, `compose.yaml`, `.env`, and key files.
2. **Update image**: Bump `image:` in `compose.yaml` while preserving the same `./data` mount and `.env`, then run:

```sh
docker compose pull && docker compose up -d --wait
```

3. **Verify upgrade**: Wait for `/readyz` to return `200`, confirm `/manage` Google sign-in works, and run one read call, one approval-gated call, and one background call from ChatGPT.
4. **Rollback**: Restore the pre-upgrade SQLite snapshot to a new DB path (Section 6) and revert the image tag and Compose configuration.

---

## 4. Packaging Release Artifacts

Building full release bundles requires **Node.js 24–26**, `npm`, and `tar` (plus Docker if passing `--with-image`):

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-<version>-SHA256SUMS
```

You can also trigger the **CI & Release** GitHub Actions workflow manually with release publishing enabled to push the Gateway image to GHCR and upload Compose files, Agent packages, offline images, and SHA-256 checksums.

---

## 5. Agent Installation & Background Service

Extract the Agent package into a stable user-owned directory, install production dependencies, pair interactively, and register it as a user-level background service:

### macOS / Linux

```sh
rcm_client="$HOME/.remote-command/client"
mkdir -p "$rcm_client"
tar -xzf /path/to/remote-command-<version>.tgz -C "$rcm_client" --strip-components=1
(cd "$rcm_client" && npm ci --omit=dev --ignore-scripts)

# 1. Pair interactively in the foreground (approve via your Google account), then press Ctrl+C
node "$rcm_client/dist/remote-cli.js" remote

# 2. Install and start the user background service
node "$rcm_client/dist/remote-cli.js" service install "$HOME/.remote-command/agent.json"
```

### Windows (PowerShell)

Extract with `tar.exe` into a fixed directory, run `npm ci --omit=dev --ignore-scripts`, and invoke `node dist\remote-cli.js` for pairing and `service install`.

### Service Mechanisms & Lifecycle

| Platform | Service Backend | Requirement |
| --- | --- | --- |
| **macOS** | `LaunchAgent` | Active user login session |
| **Linux** | `systemd` user unit | Working `systemd --user` session |
| **Windows** | Task Scheduler (user logon trigger) | Desktop PowerShell and user task write permission |

- **Subcommands**: `service` supports `install`, `render`, `status`, `start`, `stop`, and `remove`, taking the config file path as argument.
- **Smooth upgrades**: Extract the new `.tgz` into a fresh folder and run `npm ci`, run `service remove` from the old version, then run `service install` from the new version pointing at the same config file.
- **Security**: Background Agents run under your OS user account, follow system sleep policy, and stop automatically when unpaired or revoked.

---

## 6. Online Backup & Restore Drills

Backups contain users, paired devices, audit history, and any recent unpurged tool outputs. By default, the Gateway automatically purges completed task payloads (`args` / `output` / `mcp_result`) after **30 minutes** (`RCM_RESULT_TTL_MINUTES`), minimizing sensitive payload exposure inside snapshots. Restrict backup access to administrators only and keep encrypted off-site copies alongside `.env`, `data/.owner_key`, `compose.yaml`, and Nginx configs.

### Online Backup & Verification

```sh
(
  umask 077
  backup=/private/backups/rcm-$(date +%F).sqlite
  temporary=$(mktemp "$backup.XXXXXX") || exit
  trap 'rm -f -- "$temporary"' EXIT
  docker compose exec -T gateway node dist/admin.js backup > "$temporary" &&
    docker compose exec -T gateway node dist/admin.js verify-backup < "$temporary" &&
    ln -T -- "$temporary" "$backup"
)
```

### Restore Procedure

Restores write to a **new database path** so live data is never overwritten blindly:

```sh
# 1. Restore snapshot into a new path inside /data
docker compose run --rm --no-deps -T -e STATE_DB=/data/gateway-recovered.sqlite gateway \
  node dist/admin.js restore < /private/backups/rcm-YYYY-MM-DD.sqlite
```

2. During maintenance, set `STATE_DB: /data/gateway-recovered.sqlite` under `gateway.environment` in `compose.yaml` and restart:

```sh
docker compose up -d --wait gateway
```

> [!IMPORTANT]
> Restoring preserves user accounts, completed tool results, and audit history, while **clearing all dashboard sessions, OAuth sessions, and pending invites**, marking all devices revoked, and marking in-flight tasks interrupted. Afterward, sign back in to `/manage` via Google, re-pair devices, re-authorize ChatGPT, and ensure no stale Agent processes remain running.

---

## 7. Routine Operations Checklist

| Check | Verification & Notes |
| --- | --- |
| **Health** | `/healthz` (liveness) and `/readyz` (SQLite readiness) return `200`. |
| **HTTPS & OAuth** | Verify valid TLS certificates, `/.well-known/oauth-protected-resource/mcp` points to your HTTPS origin, and `/auth/google/start` redirects cleanly to Google. |
| **Logs & Disk** | Run `docker compose logs --tail 100 gateway` to monitor rate-limit or upstream OIDC errors; check Nginx logs and backup disk capacity. |
| **Retention** | Completed task payloads (`args` / `output` / `mcp_result`) default to **30 minutes** (`RCM_RESULT_TTL_MINUTES`, set `0` to disable early purge) while task metadata stays **7 days** (`RCM_TASK_RETENTION_DAYS`); desensitized usage metadata (`usage_events`, excluding arguments and outputs) is retained for **210 days** to power 6-month trends, audit logs default to **90 days** (`RCM_AUDIT_RETENTION_DAYS`), and DCR clients to **30 days** (`RCM_DCR_CLIENT_TTL_DAYS`). |
| **Long Polling & Backpressure** | `/device/sync` uses backward-compatible **HTTP Long Polling** (`RCM_LONG_POLL_MS=25000`), Gateway sync wait defaults to **15s** (`RCM_SYNC_WAIT_MS=15000`), and task leases default to **6 minutes** with automatic Agent renewal (`RCM_TASK_LEASE_MS=360000`). Per-user concurrency and queue caps default to `RCM_MAX_USER_ACTIVE=8` and `RCM_MAX_USER_WAITING=128` (ensure reverse proxies set `proxy_read_timeout 65s;`). |
| **Monthly Soft Quota Alert** | Optional `RCM_MONTHLY_SOFT_QUOTA` (positive integer; unset or `0` disables). When monthly usage reaches **80%**, both `/manage` and `who_am_i` emit a non-blocking soft alert without interrupting self-hosted calls. |
| **Free / Pro Plans & Redeem Codes** | Regular users start on **Free (10,000 billable device calls/month, resetting at 00:00 UTC on the 1st)**. Completed device tool/resource executions count as 1 call; control tools and timeouts/cancellations/denials do not count. At 80% a notice is appended; at 100% new device calls are paused while devices remain paired and `who_am_i` / `list_devices` remain available. Users can redeem **Pro codes** (`monthly`/`quarterly`/`yearly`/`lifetime`) in `/manage` → **Plan & billing**, with automatic downgrade to Free upon expiry. |
| **Admin Console Governance** | Accounts with `role = admin` gain an **Admin Console** section in `/manage` (Overview, Users & Plans, Invites & Redeem Codes, Fleet & Audit, System Policy) to enable/disable users, force sign-outs, override plans/quotas, batch-issue or revoke registration invites and Pro redeem codes, perform cross-tenant emergency device revocations, and update live policies (`registration_mode`, `free_monthly_quota`, `result_ttl_minutes`). All `/manage/api/admin/*` endpoints enforce `403 Forbidden` for regular users. |
| **Emergency Revoke & Diagnostics** | `/manage` supports revoking individual/all devices and OAuth sessions per user, plus disabling user accounts; Agents can export sanitized bundles with `remote --report`. |

Production sign-off should cover: public TLS certificates, Google OIDC admin + invited user login, real ChatGPT MCP connection, one read call, one local-approval call, one background task query, and a backup/restore drill. See [verification.md](verification.md) for recorded verification results.
