# frproxy

Declarative self-hosted ngrok on your own Cloudflare domain. You list `name -> local port` in
`config/frproxy.yml`; a small daemon makes Cloudflare match it (tunnel ingress + one proxied CNAME per name)
and `cloudflared` carries the traffic. No open ports, no public IP, runs fine on a residential box.
The apps must run on the same machine as the stack.

## Example

A fresh Linux box (`box`) with docker or podman, serving a web app on port 3000 and SSH, on a domain you own
(`example.com` here; use your own, frproxy refuses `*.example.com`):

```sh
git clone https://github.com/aurabirb/frproxy.git && cd frproxy
./frproxy install                       # link into ~/.local/bin, ask for your Cloudflare API token, start (survives reboots)

./frproxy add 3000 app.example.com      # https://app.example.com -> localhost:3000, live within seconds
./frproxy add 22 box.example.com        # SSH; also makes plain `ssh box.example.com` work on this machine
./frproxy status                        # tunnel healthy, dns/ingress ok, ssh box.example.com from this machine: ok

./frproxy ssh you@box.example.com       # run once on a client to set up ssh access through cloudflared
```

### What it does

- `install` prints how to create the token (a user or an account token) and checks it with Cloudflare before saving it
  to `config/.secrets.yml`. Enter skips it: a client that only uses `frproxy ssh` needs none.
- A domain not on Cloudflare yet is added as a zone; `status` prints the nameservers to set at your registrar.
- `frproxy ssh` downloads `cloudflared` into `~/.local/bin` and adds the host to `~/.ssh/config`, then plain `ssh`,
  `scp` and `rsync` work. Its arguments go to ssh.
- Cloudflare only proxies HTTP for plain clients, so SSH needs `cloudflared` on the machine you connect from.

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

Run one checkout per machine, all with the same Cloudflare account and token. Each machine owns its own tunnel
(`frproxy-<hostname>`) and only touches DNS records that point at it, so they never overwrite each other. If a hostname
is already served by another machine's tunnel, `plan`/`apply` refuse with a message naming it. To move a hostname,
`./frproxy rm` it on the old machine first, then add it on the new one. `./frproxy status` shows who serves what.
Upgrading from a single-instance setup: the first `apply` creates `frproxy-<hostname>` and repoints your records;
the old tunnel named `frproxy` is left behind and can be deleted in the Cloudflare dashboard.

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
- The daemon (`src/daemon.ts`) syncs Cloudflare whenever `config/frproxy.yml` or `config/.secrets.yml` changes, and every
  five minutes otherwise. It hands `cloudflared` the tunnel token through a shared volume.
- Cloudflare terminates TLS, so its proxy sees all traffic in plaintext. Its free certificate covers one label below
  the zone (`a.example.com`, not `a.b.example.com`).
- SSH: port 22 becomes an `ssh://` ingress rule. Clients run `cloudflared access ssh` as ssh's ProxyCommand; `add`,
  `apply` and `frproxy ssh` set that up as a `Host` block in `~/.ssh/config`, using the `cloudflared` release that
  `compose.yaml` pins. Hosts that already have a ProxyCommand or ProxyJump are left alone.
- `./frproxy` runs everything in containers (`src/host.ts` reaches `~/.local/bin` and `~/.ssh` through mounts), so even
  a client needs docker or podman for its first `frproxy ssh`. It works with docker compose, podman-compose and rootless
  podman (it picks whichever it finds; `FRPROXY_COMPOSE` forces one). In rootless podman the container's `root` is your
  user, so the files frproxy writes stay yours, and `install`/`apply` enable `podman-restart.service` and linger, since
  podman ignores `restart: unless-stopped` across reboots otherwise.
