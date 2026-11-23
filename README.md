# frproxy

Exposes local ports (like ngrok) on your Cloudflare domains. Does not need a public IP, open ports or anything besides
docker or podman. Just starts two small containers, a sync daemon and `cloudflared`, serving a Cloudflare tunnel.

## Example

```sh
git clone https://github.com/aurabirb/frproxy.git && cd frproxy
./frproxy install                       # link into ~/.local/bin, ask for your Cloudflare API token, start (survives reboots)

./frproxy add 3000 app.example.com      # https://app.example.com -> localhost:3000, live within seconds
./frproxy add 22 box.example.com        # SSH; also makes plain `ssh box.example.com` work on this machine
./frproxy status                        # tunnel healthy, dns/ingress ok, ssh box.example.com from this machine: ok

./frproxy ssh you@box.example.com       # run once on a client to set up ssh access through cloudflared
```

### Getting a Cloudflare token

`./frproxy install` asks for it like this (Enter skips it on a client that only uses `frproxy ssh`):

```
Serving tunnels from this machine needs a Cloudflare API token (machines that only use frproxy ssh do not).
  Create a Cloudflare API token:
    1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Create Custom Token
       (an account token, from Manage Account -> API Tokens, works too)
    2. Permissions:
         Account | Cloudflare Tunnel | Edit
         Zone    | Zone              | Edit
         Zone    | DNS               | Edit
         Account | Account Settings  | Read    (only if you do not set account_id in config/frproxy.yml)
    3. Account Resources: Include -> your account.  Zone Resources: Include -> All zones
       (a single zone works once the domain is already on Cloudflare)
Paste the token (hidden; Enter to skip):
```

Cloudflare only proxies HTTP for plain clients, so SSH needs `cloudflared` on the machine you connect from.

## Configuration

`config/frproxy.yml` (written by `add`/`rm`; hand edits apply within seconds too):

```yaml
tunnels:
  app.example.com: 3000                 # https://app.example.com -> localhost:3000
  api.example.dev: 10.0.0.5:8080        # any host:port
  box.example.com: 22                   # port 22 is SSH (ssh://); a full URL is used as written
name: box                               # optional: the tunnel is frproxy-box (default: frproxy-<hostname>)
account_id: 0123abcd                    # optional: only if the token cannot read your account ID
```

`config/.secrets.yml` (written by `install`, git-ignored, re-read on every use):

```yaml
cloudflare:
  api_token: <token>
```

## Several machines

Each machine serves its own hostnames through its own tunnel, all on one Cloudflare account:

```sh
# on each machine, with the same token:
./frproxy install                       # its tunnel is frproxy-<hostname> (set `name:` first if two share a hostname)
./frproxy add 3000 nas.example.com      # served by this machine

# move a name to another machine:
./frproxy rm nas.example.com            # on the old machine first
./frproxy add 3000 nas.example.com      # then on the new one (before the rm, its sync stops: "already served by ...")
```

## Commands

- `./frproxy install`: link `frproxy` into ~/.local/bin, ask for the Cloudflare API token if there is none, then start like `apply`
- `./frproxy add :8080 app.example.com`: expose a port, `host:port` or URL (edits `config/frproxy.yml`, previous versions kept as numbered `frproxy.yml.N.bak`)
- `./frproxy rm app.example.com`: stop exposing it
- `./frproxy status`: zone, tunnel and per-tunnel DNS/ingress state, and whether ssh to each SSH tunnel works from here
- `./frproxy plan`: show what `apply` would change, change nothing
- `./frproxy apply`: sync Cloudflare, then start (or refresh) the tunnel in the background; aborts on any error
- `./frproxy ssh [ssh args]`: set up plain ssh to a tunnel on this machine, then run ssh with the args
- `./frproxy buy <domain>`: open Cloudflare Registrar in your browser, wait until the domain is in your account, then exit 0 (so `./frproxy buy x.com && ./frproxy add 3000 app.x.com` works). Giving the token Registrar read permission also shows availability and price first
- `./frproxy help`

## How it works

- Each machine has one Cloudflare Tunnel, `frproxy-<hostname>`. `cloudflared` runs on the host network and dials out to
  Cloudflare, which is why no port has to be open and `localhost:PORT` reaches your apps.
- Each hostname gets an ingress rule on the tunnel (`hostname -> service`) and a proxied CNAME to
  `<tunnel id>.cfargotunnel.com`. CNAMEs that point at the tunnel but are no longer in the config are deleted.
- A domain not on Cloudflare yet is added as a zone; `status` prints the nameservers to set at your registrar.
- The daemon (`src/daemon.ts`) syncs Cloudflare whenever `config/frproxy.yml` or `config/.secrets.yml` changes, and every
  five minutes otherwise. It hands `cloudflared` the tunnel token through a shared volume.
- Cloudflare's free certificate covers one label below the zone (`a.example.com`, not `a.b.example.com`).
- `frproxy ssh` downloads `cloudflared` into `~/.local/bin` and adds the host with `cloudflared` as ProxyCommand. `add`
  and `apply` do the same for this machine's SSH tunnels, using the `cloudflared` release that `compose.yaml` pins;
  hosts that already have a ProxyCommand or ProxyJump in `~/.ssh/config` are left alone.
- `./frproxy` runs everything in containers (`src/host.ts` reaches `~/.local/bin` and `~/.ssh` through mounts), so even
  a client needs docker or podman for its first `frproxy ssh`. It works with docker compose, podman-compose and rootless
  podman (it picks whichever it finds; `FRPROXY_COMPOSE` forces one). In rootless podman the container's `root` is your
  user, so the files frproxy writes stay yours, and `install`/`apply` enable `podman-restart.service` and linger, since
  podman ignores `restart: unless-stopped` across reboots otherwise.
