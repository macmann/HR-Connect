# HR Connect Deployment Guide (Detailed)

This guide provides a production-grade deployment path for **HR Connect** on a Linux VM using:

- Node.js runtime
- MongoDB (managed or self-hosted)
- `systemd` as process manager
- Nginx as reverse proxy
- Let's Encrypt TLS certificates

It also includes operations, observability, rollback, and backup guidance.

---

## 1) Deployment Topology

Recommended production topology:

1. **Nginx** (public internet)
   - Terminates HTTPS
   - Handles gzip/static caching headers
   - Proxies requests to local Node process
2. **Node/Express app**
   - Runs on localhost port (e.g. `3000`)
   - Serves APIs + static front-end
3. **MongoDB**
   - Prefer managed MongoDB Atlas or secured internal cluster

---

## 2) Minimum Production Requirements

- Ubuntu 22.04 LTS (or similar modern Linux)
- 2 vCPU / 4 GB RAM minimum for small team usage
- 20+ GB SSD (adjust for CV uploads and logs)
- DNS A/AAAA record pointed to VM
- Firewall allowing inbound:
  - 80/tcp (HTTP for certificate bootstrap + redirect)
  - 443/tcp (HTTPS)

---

## 3) Prepare the Server

### 3.1 Create a dedicated user

```bash
sudo adduser --system --group --home /opt/hr-connect hrconnect
```

### 3.2 Install system packages

```bash
sudo apt update
sudo apt install -y nginx git curl build-essential ca-certificates
```

### 3.3 Install Node.js LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

> Pin to a tested LTS version in production change-control docs.

---

## 4) Deploy Application Code

### 4.1 Clone repository

```bash
sudo mkdir -p /opt/hr-connect
sudo chown -R $USER:$USER /opt/hr-connect
git clone <YOUR_REPOSITORY_URL> /opt/hr-connect/app
cd /opt/hr-connect/app
```

### 4.2 Install dependencies

```bash
npm ci --omit=dev
```

If you need dev dependencies for runtime build tasks, use:

```bash
npm ci
```

---

## 5) Configure Environment Variables

### 5.1 Create runtime env file

```bash
cp .env.example .env
nano .env
```

### 5.2 Production baseline values

Use secure values for at least:

- `ADMIN_PASSWORD`
- `PAIR_AGENT_SECRET`
- `PAIR_TOKEN_SECRET`
- `WIDGET_JWT_SECRET`
- `SMTP_PASS` (if SMTP enabled)
- `MS_CLIENT_SECRET` (if SSO enabled)

### 5.3 Example production settings

```env
NODE_ENV=production
PORT=3000
CORS_ALLOWED_ORIGINS=https://hr.example.com
SESSION_COOKIE_NAME=session_token
SESSION_COOKIE_MAX_AGE=604800000
SESSION_COOKIE_SAMESITE=lax

MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=hrconnect

ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=<STRONG_RANDOM_PASSWORD>

PAIR_AGENT_ID=agent-service
PAIR_AGENT_SECRET=<STRONG_RANDOM_SECRET>
PAIR_TOKEN_SECRET=<STRONG_RANDOM_SECRET>
PAIR_TOKEN_ISSUER=hr-connect
PAIR_TOKEN_AUDIENCE=agent-clients
PAIR_TOKEN_SCOPE=pair:connect
PAIR_TOKEN_TTL_SECONDS=300

WIDGET_JWT_SECRET=<STRONG_RANDOM_SECRET>
WIDGET_JWT_EXPIRES_IN=300
```

### 5.4 File permissions

```bash
chmod 600 .env
```

---

## 6) Pre-Flight Validation

From `/opt/hr-connect/app`:

```bash
npm test
node -e "require('./db').init().then(()=>{console.log('db ok');process.exit(0)}).catch(err=>{console.error(err);process.exit(1)})"
```

If migrating old leave data:

```bash
node scripts/migrateLeaveSystem.js
```

---

## 7) Run as a systemd Service

### 7.1 Create unit file

```bash
sudo nano /etc/systemd/system/hr-connect.service
```

Paste:

```ini
[Unit]
Description=HR Connect API and Web Server
After=network.target

[Service]
Type=simple
User=hrconnect
Group=hrconnect
WorkingDirectory=/opt/hr-connect/app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/hr-connect/app/.env
StandardOutput=append:/var/log/hr-connect/app.log
StandardError=append:/var/log/hr-connect/app-error.log

[Install]
WantedBy=multi-user.target
```

### 7.2 Create log directory and ownership

```bash
sudo mkdir -p /var/log/hr-connect
sudo touch /var/log/hr-connect/app.log /var/log/hr-connect/app-error.log
sudo chown -R hrconnect:hrconnect /var/log/hr-connect
sudo chown -R hrconnect:hrconnect /opt/hr-connect
```

### 7.3 Enable and start service

```bash
sudo systemctl daemon-reload
sudo systemctl enable hr-connect
sudo systemctl start hr-connect
sudo systemctl status hr-connect --no-pager
```

### 7.4 Live logs

```bash
sudo journalctl -u hr-connect -f
```

---

## 8) Configure Nginx Reverse Proxy

### 8.1 Create site config

```bash
sudo nano /etc/nginx/sites-available/hr-connect
```

Use:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name hr.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }

    client_max_body_size 10m;
}
```

### 8.2 Enable site and reload Nginx

```bash
sudo ln -s /etc/nginx/sites-available/hr-connect /etc/nginx/sites-enabled/hr-connect
sudo nginx -t
sudo systemctl reload nginx
```

---

## 9) Enable HTTPS with Let's Encrypt

Install certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Issue certificate:

```bash
sudo certbot --nginx -d hr.example.com
```

Verify auto-renew timer:

```bash
systemctl list-timers | rg certbot
```

Optional dry run:

```bash
sudo certbot renew --dry-run
```

---

## 10) Security Hardening Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Restrict MongoDB network access (allowlist app source only)
- [ ] Use strong random secrets in `.env`
- [ ] Rotate admin bootstrap password after initial setup
- [ ] Restrict SSH (key-based auth, disable password auth)
- [ ] Enable unattended security updates
- [ ] Configure OS firewall (`ufw`) to only required ports
- [ ] Keep dependencies patched (`npm audit` + routine updates)
- [ ] Validate CORS origin list for production domains only

---

## 11) Release Workflow (Zero/Low Downtime)

From deployment host:

```bash
cd /opt/hr-connect/app
git fetch --all
git checkout <target_branch>
git pull --ff-only
npm ci --omit=dev
npm test
sudo systemctl restart hr-connect
sudo systemctl status hr-connect --no-pager
```

Post-deploy smoke checks:

```bash
curl -I https://hr.example.com/
curl -sS https://hr.example.com/api/public/careers | head
```

---

## 12) Rollback Procedure

1. Identify prior known-good commit/tag.
2. Checkout that revision.
3. Reinstall dependencies for lockfile at that revision.
4. Restart service.

```bash
cd /opt/hr-connect/app
git log --oneline -n 20
git checkout <known_good_tag_or_commit>
npm ci --omit=dev
sudo systemctl restart hr-connect
```

If a data migration ran and is not backward-compatible, use database snapshots before rollback.

---

## 13) Backup and Restore

### 13.1 Backup strategy

- Daily MongoDB snapshot (`mongodump` or managed backup policy)
- Retention policy (e.g. 7 daily, 4 weekly, 3 monthly)
- Encrypted offsite storage

Example `mongodump`:

```bash
mongodump --uri="$MONGODB_URI" --db="$MONGODB_DB" --out="/var/backups/hr-connect/$(date +%F)"
```

### 13.2 Restore drill

Run periodic restore drills in staging:

```bash
mongorestore --uri="$MONGODB_URI" --nsInclude="$MONGODB_DB.*" /var/backups/hr-connect/<DATE>/$MONGODB_DB
```

Validate login, employee listing, leave flows, and careers submission after restore.

---

## 14) Monitoring and Alerting

Minimum recommended signals:

- Service liveness: `systemctl is-active hr-connect`
- HTTP health/smoke check
- 5xx response rate
- Process memory/CPU trend
- MongoDB latency and connection health
- Disk utilization (logs and uploads)

Suggested integrations: CloudWatch, Datadog, Grafana+Prometheus, or your preferred stack.

---

## 15) Troubleshooting

### App fails to start

- Check syntax and missing env variables:
  ```bash
  sudo systemctl status hr-connect --no-pager
  sudo journalctl -u hr-connect -n 200 --no-pager
  ```

### MongoDB connection issues

- Validate URI, IP allowlist, TLS flags, and credentials.
- If necessary, tune:
  - `MONGODB_FORCE_TLS`
  - `MONGODB_TLS_MIN_VERSION`
  - `MONGODB_TLS_ALLOW_INVALID_CERTS` (debug only)
  - `MONGODB_SERVER_SELECTION_TIMEOUT_MS`

### CORS/auth issues in browser

- Confirm `CORS_ALLOWED_ORIGINS` exactly matches deployed frontend origin.
- Confirm reverse proxy passes `Host` and `X-Forwarded-*` headers.
- Verify cookie same-site behavior and HTTPS usage.

### File upload issues

- Increase Nginx `client_max_body_size`.
- Ensure upload path exists and service user can write.

---

## 16) Optional: Containerized Deployment Notes

If your platform standard is containers, package the app in Docker and run behind ingress with managed TLS. Preserve the same principles:

- externalized env vars,
- persistent volume strategy for uploads,
- health checks,
- controlled rollout + rollback,
- database backup policy.

---

## 17) Post-Deployment Acceptance Checklist

- [ ] HTTPS certificate valid and auto-renewing
- [ ] Login works (local and SSO if enabled)
- [ ] Employee list endpoint loads
- [ ] Leave submission and manager decision path works
- [ ] Careers page and public applications endpoint works
- [ ] AI/recruitment and learning routes accessible per role
- [ ] Scheduled jobs confirmed in logs
- [ ] Backup job executed and restore drill scheduled

