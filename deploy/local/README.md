# Sousa Group One — migration Render -> serveur Proxmox local

This deployment keeps Sousa Group One in its own Linux VM on Proxmox. Do not install
it inside the Home Assistant VM.

## Recommended VM

- Ubuntu Server 24.04 LTS or Debian 12/13
- 2 vCPU
- 2-4 GB RAM
- 40 GB disk minimum
- fixed LAN IP / DHCP reservation

The application stack is:

- Node.js 24 application container
- PostgreSQL 16 container
- persistent PostgreSQL Docker volume
- host-mounted backup directory
- optional Cloudflare Tunnel container for public HTTPS access

## 1. Install Docker and clone the repository

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker

cd /opt
sudo git clone https://github.com/Jsousa1114/sousa-group-one.git
sudo chown -R "$USER":"$USER" /opt/sousa-group-one
cd /opt/sousa-group-one
git checkout deploy/local-proxmox
```

## 2. Create the local environment file

```bash
cp deploy/local/.env.example deploy/local/.env

DB_PASSWORD="$(openssl rand -hex 24)"
JWT_SECRET="$(openssl rand -hex 48)"

sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$DB_PASSWORD/" deploy/local/.env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" deploy/local/.env

chmod 600 deploy/local/.env
nano deploy/local/.env
```

Important before migration:

- If TOTP/2FA is already used, copy the exact existing `TOTP_ENCRYPTION_KEY` from
  Render into this file. Do not generate a replacement.
- Copy any AI, TURN and object-storage credentials that are already used.
- A new `JWT_SECRET` is acceptable, but every existing session will be logged out.

## 3. Start PostgreSQL only

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml up -d db
```

## 4. Export the Render PostgreSQL database

The Render database must be exported before its expiry.

In the Render dashboard:

1. Open `sousa-group-one-db`.
2. Open **Networking**.
3. Add only the public IPv4 of the home connection as a `/32` allowlist entry.
4. Copy the **External Database URL**.

To obtain the public IPv4 from the server:

```bash
curl -4 https://api.ipify.org ; echo
```

On the server, enter the Render database URL without saving it to shell history:

```bash
read -rsp "Render External Database URL: " RENDER_DATABASE_URL
export RENDER_DATABASE_URL
echo

cd /opt/sousa-group-one
docker run --rm \
  -e RENDER_DATABASE_URL="$RENDER_DATABASE_URL" \
  postgres:16-bookworm \
  sh -c 'pg_dump "$RENDER_DATABASE_URL" -Fc --no-owner --no-acl' \
  > "deploy/local/render-sgo-$(date +%F-%H%M).dump"

unset RENDER_DATABASE_URL
ls -lh deploy/local/render-sgo-*.dump
```

Do not delete the Render database yet.

## 5. Restore the dump into local PostgreSQL

```bash
cd /opt/sousa-group-one
set -a
source deploy/local/.env
set +a

DUMP_FILE="$(ls -1t deploy/local/render-sgo-*.dump | head -n1)"

docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml exec -T db \
  pg_restore \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --clean --if-exists --no-owner --no-acl \
  < "$DUMP_FILE"
```

If the restore is successful, keep the dump as a second copy until the migration is fully verified.

## 6. Start Sousa Group One

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml up -d --build app

docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml ps

curl -fsS http://127.0.0.1:3000/healthz
echo
curl -fsS http://127.0.0.1:3000/readyz
echo
```

From another device on the home network, open:

```text
http://SERVER_LAN_IP:3000
```

This HTTP LAN address is only for the temporary migration test. Camera, microphone and
Passkeys require a secure HTTPS context for normal production use.

## 7. Verify data before switching production

Check at minimum:

- admin login
- employees/accounts
- clients
- projects
- hours and planning
- quotes/invoices/payments
- documents and file downloads
- messaging
- user roles/permissions
- 2FA if enabled
- `/healthz` and `/readyz`

Do not shut down Render until this comparison is complete.

## 8. Public HTTPS access with Cloudflare Tunnel

Recommended: use a stable hostname such as `app.example.com` and route it to:

```text
http://app:3000
```

Create the tunnel in Cloudflare Zero Trust, copy its token into
`deploy/local/.env`, then set:

```dotenv
COOKIE_SECURE=true
WEBAUTHN_RP_ID=app.example.com
WEBAUTHN_ORIGIN=https://app.example.com
CLOUDFLARE_TUNNEL_TOKEN=...
```

Start the application and tunnel:

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml --profile tunnel up -d --build
```

If the public hostname changes from the previous production RP ID, existing Passkeys may
need to be registered again. Password authentication is independent from that.

## 9. Daily local backup

The application can create a compressed logical backup. The compose file maps
`/app/backups` to `deploy/local/backups`.

Test it:

```bash
docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml exec -T app npm run backup

ls -lh deploy/local/backups
```

Example root cron entry for 02:15 every day:

```cron
15 2 * * * cd /opt/sousa-group-one && docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml exec -T app npm run backup >> /var/log/sgo-backup.log 2>&1
```

A backup on the same physical disk is not enough for disaster recovery. Replicate the
backup folder to a NAS, another machine or encrypted cloud/object storage.

## 10. Updating the app later

```bash
cd /opt/sousa-group-one
git pull
docker compose --env-file deploy/local/.env \
  -f deploy/local/docker-compose.yml up -d --build app
```

Always make a database backup before a major update.
