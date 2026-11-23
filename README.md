# cfproxy

Exposes local ports (like ngrok) using free Cloudflare tunnels with or without a domain name. No public IP or open ports
needed. Just runs cloudflared and bun in containers.

## Example

```sh
git clone https://github.com/aurabirb/cfproxy.git && cd cfproxy
./cfproxy install                       # link into ~/.local/bin, ask for a Cloudflare API token (Enter skips), start (survives reboots)

# Without a domain (completely free):
./cfproxy add 3000 myapp                # prints https://<random-words>.trycloudflare.com -> localhost:3000 (new words on restart)
./cfproxy add 22 nas                    # SSH; prints the command for the client: ./cfproxy ssh nas=<random-words>[.trycloudflare.com]
./cfproxy ssh nas=<random-words>[.trycloudflare.com]  # on a client: alias nas in ~/.ssh/config (rerun with new words after a restart)
rsync -a photos/ you@nas:photos/        # ssh, scp, rsync and git all work with the alias

# Using your own domain:
./cfproxy add 3000 app.example.com      # https://app.example.com -> localhost:3000, live within seconds
./cfproxy add 22 box.example.com        # SSH; also makes plain `ssh box.example.com` work on this machine
./cfproxy status                        # tunnel healthy, dns/ingress ok, ssh box.example.com from this machine: ok
./cfproxy ssh you@box.example.com       # run once on a client to set up ssh access through cloudflared
```

Cloudflare only proxies HTTP for plain clients, so SSH needs `cloudflared` on the machine you connect from.
A name without a dot (`./cfproxy add 3000 myapp`) is a
[quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
no domain or Cloudflare account needed.

[Optional] Creating a Cloudflare API token:

1. [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** →
   **Create Custom Token** (an account token, from Manage Account → API Tokens, works too)
2. Permissions:

   | Scope   | Resource          | Access |
   | ------- | ----------------- | ------ |
   | Account | Cloudflare Tunnel | Edit   |
   | Zone    | Zone              | Edit   |
   | Zone    | DNS               | Edit   |
   | Account | Account Settings  | Read (only if you do not set `account_id` in `config/cfproxy.yml`) |

3. **Account Resources:** Include → your account. **Zone Resources:** Include → All zones
   (a single zone works once the domain is already on Cloudflare)

## Configuration

`config/cfproxy.yml` (written by `add`/`rm`; hand edits apply within seconds too, to quick tunnels after `./cfproxy apply`):

```yaml
tunnels:
  app.example.com: 3000                 # https://app.example.com -> localhost:3000
  api.example.dev: 10.0.0.5:8080        # any host:port
  box.example.com: 22                   # port 22 is SSH (ssh://); a full URL is used as written
  myapp: 3000                           # no dot: quick tunnel at a random https://....trycloudflare.com
name: box                               # optional: the tunnel is cfproxy-box (default: cfproxy-<hostname>)
account_id: 0123abcd                    # optional: only if the token cannot read your account ID
```

`config/.secrets.yml` (written by `install`, git-ignored, re-read on every use):

```yaml
cloudflare:
  api_token: <token>
```

## Several machines

Each machine serves its own hostnames through its own tunnel, all on one Cloudflare account. Quick tunnels are not
shared: each machine runs its own, with its own random hostname, so two machines can use the same name.

```sh
# on each machine, with the same token:
./cfproxy install                       # its tunnel is cfproxy-<hostname> (set `name:` first if two share a hostname)
./cfproxy add 3000 nas.example.com      # served by this machine

# move a name to another machine:
./cfproxy rm nas.example.com            # on the old machine first
./cfproxy add 3000 nas.example.com      # then on the new one (before the rm, its sync stops: "already served by ...")
```

## Commands

- `./cfproxy install`: link `cfproxy` into ~/.local/bin, ask for the Cloudflare API token if there is none, then start like `apply` (on machines that serve tunnels; clients only need `./cfproxy ssh`)
- `./cfproxy add :8080 app.example.com`: expose a port, `host:port` or URL (edits `config/cfproxy.yml`, previous versions kept as numbered `cfproxy.yml.N.bak`)
- `./cfproxy add 3000 quicktest`: expose it through a quick tunnel instead, at a random https://….trycloudflare.com that `add` and `status` print
- `./cfproxy rm app.example.com`: stop exposing it
- `./cfproxy status`: zone, tunnel and per-tunnel DNS/ingress state, quick tunnel URLs, and whether ssh to each SSH tunnel works from here
- `./cfproxy plan`: show what `apply` would change, change nothing
- `./cfproxy apply`: sync Cloudflare, then start (or refresh) the tunnels in the background; aborts on any error
- `./cfproxy ssh [alias=<quick tunnel>] [ssh args]`: set up plain ssh to a tunnel on this machine (or the alias), then run ssh with the args
- `./cfproxy buy <domain>`: open Cloudflare Registrar in your browser, wait until the domain is in your account, then exit 0 (so `./cfproxy buy x.com && ./cfproxy add 3000 app.x.com` works). Giving the token Registrar read permission also shows availability and price first
- `./cfproxy help`

## How it works

- Each machine has one Cloudflare Tunnel, `cfproxy-<hostname>`. `cloudflared` runs on the host network and dials out to
  Cloudflare, which is why no port has to be open and `localhost:PORT` reaches your apps.
- Each hostname gets an ingress rule on the tunnel (`hostname -> service`) and a proxied CNAME to
  `<tunnel id>.cfargotunnel.com`. CNAMEs that point at the tunnel but are no longer in the config are deleted.
- A domain not on Cloudflare yet is added as a zone; `status` prints the nameservers to set at your registrar.
- The daemon (`src/daemon.ts`) syncs Cloudflare whenever `config/cfproxy.yml` or `config/.secrets.yml` changes, and every
  five minutes otherwise. It hands `cloudflared` the tunnel token through a shared volume.
- The `cloudflared` containers (the named tunnel's, and one per quick tunnel) are generated from `compose.yaml`'s
  `x-cloudflared` into `config/compose.tunnels.yaml` (`src/quick.ts`). `add`, `rm` and `apply` rewrite it and start or
  remove containers; compose recreates only changed ones, so other quick tunnels keep their URLs. The daemon reads
  those URLs from each container's metrics server, so it runs on the host network.
- Cloudflare's free certificate covers one label below the zone (`a.example.com`, not `a.b.example.com`).
- `cfproxy ssh` downloads `cloudflared` into `~/.local/bin` and adds the host with `cloudflared` as ProxyCommand. `add`
  and `apply` do the same for this machine's SSH tunnels, using the `cloudflared` release that `compose.yaml` pins;
  hosts that already have a ProxyCommand or ProxyJump in `~/.ssh/config` are left alone.
- `./cfproxy` runs everything in containers (`src/host.ts` reaches `~/.local/bin` and `~/.ssh` through mounts), so even
  a client needs docker or podman for its first `cfproxy ssh`. It works with docker compose, podman-compose and rootless
  podman (it picks whichever it finds; `CFPROXY_COMPOSE` forces one). In rootless podman the container's `root` is your
  user, so the files cfproxy writes stay yours, and `install`/`apply` enable `podman-restart.service` and linger, since
  podman ignores `restart: unless-stopped` across reboots otherwise.
