# Deployment Targets

## Constraints

A scaffolded Guppy agent is a **persistent Bun process** with hard requirements that eliminate serverless/ephemeral platforms:

| Requirement | Why |
|---|---|
| **Long-running process** | Discord Gateway WebSocket, event bus FS watcher, in-memory actor state |
| **Writable filesystem** | `data/` directory — logs, context, memory, skills, events (all file-based) |
| **Bun runtime** | Core + scaffolded code targets Bun APIs (`Bun.serve`, `Bun.spawn`, etc.) |
| **Inbound HTTP** | Webhook callbacks from Slack, Teams, Google Chat |
| **Outbound WebSocket** | Discord Gateway (persistent, reconnects every 12h) |
| **Optional: Docker socket** | Docker sandbox mode needs `docker exec` access |

---

## Minimum Requirements

A Guppy agent is lightweight — single-threaded Bun process, modest memory footprint, minimal disk I/O.

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| **CPU** | 1 shared vCPU | 2 vCPU | LLM calls are network-bound, not CPU-bound. CPU matters for bash tool execution |
| **RAM** | 256 MB | 512 MB–1 GB | Base process ~50-100 MB. Each active actor adds ~10-20 MB (context + mailbox). 5 concurrent threads ≈ 200 MB |
| **Disk** | 20 GB | 100 GB | `data/` grows with usage: `log.jsonl` + `context.jsonl` per thread, downloaded attachments (images, PDFs, files), scratch workspace per thread, skills scripts. Compaction bounds context but logs and attachments accumulate indefinitely |
| **Bandwidth** | 1 GB/mo | 5 GB/mo | LLM API calls dominate egress. Webhook payloads are tiny. Attachments vary |
| **Kernel** | Linux 5.1+ | 5.6+ | Bun requirement. All current provider images meet this |
| **Architecture** | x86_64 or ARM64 | ARM64 (better $/perf) | Bun supports both. ARM instances cheaper on Hetzner/AWS |

---

## Estimated Costs

### VPS Providers

Plans shown meet the 20 GB minimum disk. Block storage used to reach 100 GB recommended where plan disk is insufficient.

| Provider | Plan | vCPU | RAM | Plan Disk | Block Storage $/GB | Min (20 GB) $/mo | Rec (100 GB) $/mo | Notes |
|---|---|---|---|---|---|---|---|---|
| **Hetzner** | CX23 | 2 | 4 GB | 40 GB | $0.05 | **~$4** | **~$7** | Best value. 40 GB included, +60 GB block = 100 GB |
| **Hetzner** | CAX11 (ARM) | 2 | 4 GB | 40 GB | $0.05 | **~$4** | **~$7** | ARM64, slightly better $/perf |
| **Hetzner** | CX43 | 8 | 16 GB | 160 GB | — | — | **~$10** | 100 GB native, no block storage needed |
| **AWS Lightsail** | Nano | 2 | 512 MB | 20 GB | $0.10 | **$3.50** | **$12** | IPv6-only ($5 w/ IPv4). 3mo free (new accounts) |
| **Linode** | Nanode | 1 | 1 GB | 25 GB | $0.10 | **$5** | **$13** | Solid baseline |
| **DigitalOcean** | Basic 1 GB | 1 | 1 GB | 25 GB | $0.10 | **$6** | **$14** | Simple UI. No free tier |
| **Vultr** | Cloud Compute | 1 | 1 GB | 25 GB | $0.10 | **$6** | **$14** | $5 base + block storage |
| **AWS EC2** | t4g.micro | 2 | 1 GB | EBS | $0.08 | **~$8** | **~$14** | ARM64. Free tier through Dec 2026 (t4g.small) |

**VPS recommendation:** Hetzner CX23/CAX11 at ~$4-7/mo. 40 GB included, block storage at $0.05/GB (cheapest). For 100 GB without block storage, Hetzner CX43 at ~$10/mo includes 160 GB disk natively.

### PaaS Platforms

| Platform | Plan | Compute $/mo | Volume $/GB/mo | Min (20 GB) $/mo | Rec (100 GB) $/mo | Notes |
|---|---|---|---|---|---|---|
| **Fly.io** | Pay-as-you-go | ~$2 (shared-1x 256MB) | $0.15 | **~$5** | **~$17** | No free tier for new orgs |
| **Railway** | Hobby ($5) | incl in $5 credit | $0.15 | **~$8** | **N/A** | Hobby volume limit: 5 GB. Need Pro ($20) for >5 GB |
| **Railway** | Pro ($20) | $20/vCPU + $10/GB | $0.15 | **~$25** | **~$37** | $20 sub includes $20 usage credit |
| **Coolify** | Self-hosted | VPS cost | VPS disk | **~$4** | **~$7** | Free software + Hetzner VPS |
| **Render** | Starter | $7 | $0.25 | **~$12** | **~$32** | Most expensive. Free tier sleeps |

**PaaS caveat:** Railway Hobby limits volumes to 5 GB — insufficient for the 20 GB minimum. Railway Pro at $20/mo base makes it expensive. Fly.io is the only PaaS that stays competitive at scale.

### Docker Compose (self-hosted)

Same cost as the underlying VPS. No additional platform fees. Only adds Docker runtime overhead (~100 MB RAM).

### Cost Summary

| Target | Min $/mo (20 GB) | Rec $/mo (100 GB) | Best for |
|---|---|---|---|
| **Hetzner VPS + systemd** | ~$4 | ~$7 | Production. Best value, most control |
| **Coolify + Hetzner** | ~$4 | ~$7 | PaaS UX on your own hardware |
| **Docker Compose + Hetzner** | ~$4 | ~$7 | Containerized, same VPS cost |
| **Fly.io** | ~$5 | ~$17 | Managed PaaS, minimal ops |
| **Linode VPS** | $5 | ~$13 | Simple alternative to Hetzner |
| **Lightsail** | $3.50 | ~$12 | AWS ecosystem |
| **Railway Pro** | ~$25 | ~$37 | Simplest DX but expensive |
| **Render** | ~$12 | ~$32 | Not recommended |
| **AWS EC2 (free tier)** | $0 | ~$8 | Free compute through Dec 2026 |

---

## Tier 1 — Primary Targets

These are the platforms `guppy create` should scaffold for directly.

### 1. Linux VPS + systemd (current default)

The existing design target. Cheapest, most control, simplest mental model.

**Providers:** Hetzner, DigitalOcean, Linode, Vultr, AWS Lightsail

**What the CLI scaffolds today:**
- systemd user service file (`~/.config/systemd/user/{name}.service`)
- `EnvironmentFile` pointing to `.env`
- `Restart=always` for crash recovery
- `loginctl enable-linger` for post-logout persistence

**Still needed:**
- TLS termination — reverse proxy (Caddy recommended: auto-HTTPS, zero config) or Cloudflare Tunnel
- DNS — manual or Cloudflare
- Bun installed on host (`curl -fsSL https://bun.sh/install | bash`)

**Scaffold additions to consider:**
- Optional `Caddyfile` generation (reverse proxy + auto-TLS)
- Optional `cloudflared` config for tunnel mode (resolves SPEC.md open question #1)

```
Min: ~$4/mo  (Hetzner CX23, 40 GB disk)
Rec: ~$7/mo  (Hetzner CX23 + 60 GB block storage = 100 GB)
     ~$10/mo (Hetzner CX43, 160 GB native — no block storage)
Free: AWS EC2 t4g.small free tier through Dec 2026
Disk: persistent, local FS
TLS: Caddy / Cloudflare Tunnel / manual
Deploy: git pull && bun install && guppy restart
```

### 2. Docker Compose (self-hosted)

Natural extension — especially for users already choosing Docker sandbox mode. Single `docker compose up -d` gets everything running.

**What to scaffold:**
- `Dockerfile` (Bun base image, copy source, expose port)
- `docker-compose.yml` (service + volume for `data/`, optional Caddy sidecar)
- Volume mount for `data/` persistence
- If Docker sandbox: mount Docker socket or use DinD sidecar

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

```yaml
services:
  agent:
    build: .
    env_file: .env
    ports: ["3000:3000"]
    volumes: ["./data:/app/data"]
    restart: always
```

```
Cost: host cost only
Disk: volume-mounted
TLS: Caddy sidecar or host-level proxy
Deploy: docker compose up -d --build
```

### 3. Railway

Best PaaS option. Supports persistent processes, Bun runtime, persistent volumes, auto-TLS.

**Why it works:**
- Native Bun detection (or Dockerfile)
- Persistent volumes for `data/`
- Automatic HTTPS + custom domains
- Push-to-deploy from GitHub
- No cold starts — process stays running

**Caveats:**
- Volume limited to single replica (no horizontal scaling — fine for Guppy's single-instance model)
- Docker sandbox would need Dockerfile-based deploy with Docker socket (limited)

```
Hobby ($5/mo): Volume limit 5 GB — insufficient for 20 GB min
Pro ($20/mo):
  Min: ~$25/mo (compute + 20 GB volume)
  Rec: ~$37/mo (compute + 100 GB volume)
  Volume: $0.15/GB/mo, egress: $0.05/GB
Disk: persistent volume
TLS: automatic
Deploy: git push / railway up
```

### 4. Fly.io

Container-based platform with persistent volumes and global edge.

**Why it works:**
- Persistent processes (Machines API)
- Volumes for `data/`
- Automatic TLS + Anycast IP
- Good WebSocket support (Discord Gateway)
- Dockerfile-based deployment

**Caveats:**
- Machines can be stopped for inactivity (need `auto_stop_machines = false`)
- Volume tied to single region/machine
- Docker sandbox needs rootful container or privileged mode

```
Min: ~$5/mo  (shared-cpu-1x 256MB ~$2 + 20 GB volume $3)
Rec: ~$17/mo (shared-cpu-1x 256MB ~$2 + 100 GB volume $15)
Volume: $0.15/GB/mo, egress: $0.02/GB (NA/EU)
No free tier for new orgs
Disk: persistent volume (per-machine, per-region)
TLS: automatic
Deploy: fly deploy
```

---

## Tier 2 — Viable, Less Ideal

### 5. Coolify (self-hosted PaaS)

PaaS experience on your own VPS. Docker-based, supports volumes, auto-TLS via Traefik. Free open-source software — you only pay for the VPS (~$4-6/mo). Managed cloud dashboard option at $5/mo if you don't want to self-host Coolify itself.

Good for users who want VPS control + PaaS deploy UX. Adds overhead of running Coolify itself.

### 6. Render

Supports persistent services with persistent disks. Bun via Dockerfile. Auto-TLS.

**~$7.25/mo** minimum (Starter instance $7 + disk $0.25/GB). Most expensive option for this use case. Free tier sleeps after 15 min inactivity (unusable for webhooks/Gateway).

### 7. Cloud VMs (AWS EC2, GCP GCE, Azure VM)

Same as VPS + systemd but with cloud provider overhead. AWS EC2 t4g.small has a free tier through Dec 2026 (2 vCPU, 2 GB RAM ARM64). Otherwise ~$6+/mo for comparable specs.

---

## Not Viable

| Platform | Why |
|---|---|
| **AWS Lambda / GCP Cloud Functions** | No persistent process, no filesystem, cold starts |
| **Vercel / Netlify** | Serverless — no WebSocket, no persistent state, no FS |
| **Cloudflare Workers** | No persistent process, no Node/Bun APIs, no FS |
| **Heroku** | Ephemeral filesystem — `data/` wiped on every deploy/restart |
| **Cloud Run** | Can run persistent but: ephemeral FS, no Docker socket, awkward for WebSocket |

---

## CLI Scaffold Strategy

The `guppy create` scaffold prompt should offer a deployment target:

```
? Deployment target?
  ◉ systemd (Linux VPS — Hetzner, DigitalOcean, etc.)
  ◯ Docker Compose (self-hosted)
  ◯ Railway
  ◯ Fly.io
  ◯ Manual (just the app, no deploy config)
```

Each target generates additional files:

| Target | Extra files |
|---|---|
| **systemd** | `{name}.service`, optional `Caddyfile` |
| **Docker Compose** | `Dockerfile`, `docker-compose.yml` |
| **Railway** | `Dockerfile`, `railway.toml` |
| **Fly.io** | `Dockerfile`, `fly.toml` |
| **Manual** | Nothing — just the app |

All targets share the same `src/` scaffold. The deployment target only affects infra files.

---

## Open Question Resolution

This document proposes resolving **SPEC.md Open Question #1** (endpoint exposure):

- **systemd target**: Generate optional `Caddyfile` for auto-TLS, or `cloudflared` config for tunnel mode
- **Docker Compose target**: Caddy sidecar in compose file handles TLS
- **PaaS targets (Railway, Fly.io)**: TLS is automatic, no config needed
- **Manual target**: User handles everything

Recommendation: **Option C from SPEC.md** — scaffold with direct server, optionally include reverse proxy / tunnel config based on deployment target.
