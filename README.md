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
./frproxy install                       # links `frproxy` into ~/.local/bin, asks for your Cloudflare API token

./frproxy add 3000 app.example.com      # https://app.example.com -> localhost:3000 (creates config/frproxy.yml)
./frproxy add 22 box.example.com        # SSH; prints what clients need

./frproxy plan                          # preview: + tunnel frproxy-box, ingress, + CNAME app/box.example.com
./frproxy apply                         # sync Cloudflare, start the tunnel in the background, survive reboots
./frproxy status                        # tunnel healthy, dns/ingress ok, ssh box.example.com from this machine: ok

./frproxy ssh you@box.example.com       # from any machine with a checkout; fetches cloudflared on first use
./frproxy ssh -N -L 8080:localhost:3000 you@box.example.com    # forward a port that is not in the tunnel list
rsync -av -e "./frproxy ssh" ./site/ you@box.example.com:site/  # anything that takes an ssh command
```

`https://app.example.com` now reaches the app.

`./frproxy` alone lists all commands.

The token needs Account | Cloudflare Tunnel | Edit, Zone | Zone | Edit, Zone | DNS | Edit and Account | Account Settings |
Read; Account Resources: your account, Zone Resources: All zones. `install` prints these steps and checks the token with
Cloudflare before saving it to `config/.secrets.yml`; Enter skips it on machines that only use `frproxy ssh`. The file is
re-read on every use (and wakes the daemon), so fixing a token needs no restart. Any error aborts `apply` before anything
is started.
If a hostname's domain is not on Cloudflare yet, `apply` creates the zone (the last two labels of the hostname, so
`co.uk`-style domains must be added to Cloudflare first) and prints the two nameservers to set at your registrar; the
background daemon keeps polling until it is active. That is the only manual step besides the token.

## Use

Edit `config/frproxy.yml` and save; the daemon applies it within seconds:

```yaml
tunnels:
  thoughts.example.com: 9009        # https://thoughts.example.com -> localhost:9009
  api.other-domain.dev: 10.0.0.5:3000   # any host:port, or a URL like ssh://localhost:22
```

A bare port 22 (`22` or `host:22`) is treated as SSH (`ssh://`). Cloudflare only proxies HTTP for plain clients, so SSH
needs `cloudflared` on the machine you connect from:

- On any machine with a checkout (no containers or config needed): `./frproxy ssh user@box.example.com` downloads the
  `cloudflared` release that `compose.yaml` pins into `~/.local/bin` if there is none, then runs ssh through it. All
  arguments go to ssh.
- `./frproxy apply` makes plain `ssh` work on the machine running it: it installs `cloudflared` the same way and appends a
  `Host … ProxyCommand cloudflared access ssh` block to `~/.ssh/config` for each SSH tunnel, unless ssh already has a
  ProxyCommand or ProxyJump for it.
- `./frproxy status` says per SSH tunnel whether `ssh` to it works from this machine, and why not.

Hostnames are always full (`name.domain`), and the domains can be any zones in your Cloudflare account.

Removing a tunnel removes the CNAME it created.

Optional top-level keys in `config/frproxy.yml`:

```yaml
name: laptop          # this machine's tunnel is frproxy-laptop (default: frproxy-<hostname>)
account_id: 0123abcd  # only if the API token cannot read your account ID
```

## Several machines

Run one checkout per machine, all with the same Cloudflare account and token. Each machine owns its own tunnel
(`frproxy-<hostname>`) and only touches DNS records that point at it, so they never overwrite each other. If a hostname
is already served by another machine's tunnel, `plan`/`apply` refuse with a message naming it. To move a hostname,
`./frproxy rm` it on the old machine first, then add it on the new one. `./frproxy status` shows who serves what.
Upgrading from a single-instance setup: the first `apply` creates `frproxy-<hostname>` and repoints your records;
the old tunnel named `frproxy` is left behind and can be deleted in the Cloudflare dashboard.

## Commands

- `./frproxy buy <domain>`: open Cloudflare Registrar in your browser, wait until the domain is in your account, then exit 0 (so `./frproxy buy x.com && ./frproxy add 3000 app.x.com` works). Giving the token Registrar read permission also shows availability and price first
- `./frproxy plan`: show what `apply` would change, change nothing (works on a first run too)
- `./frproxy apply`: sync Cloudflare, then start (or refresh) the tunnel in the background; aborts on any error
- `./frproxy status`: zone, tunnel and per-tunnel DNS/ingress state
- `./frproxy add :8080 wrong.example.com`: expose a port, `host:port` or URL (edits `config/frproxy.yml`, previous versions kept as numbered `frproxy.yml.N.bak`)
- `./frproxy rm wrong.example.com`: stop exposing it
- `./frproxy install`: link `frproxy` into ~/.local/bin and ask for the Cloudflare API token if there is none
- `./frproxy ssh [ssh args]`: ssh through an SSH tunnel from any machine, installing cloudflared first if needed
- `./frproxy help`

After `apply`, edits to `config/frproxy.yml` are picked up by the background daemon within seconds.

## Pieces

- `src/config.ts`: owns `config/frproxy.yml` (validation, load, save with numbered backups, `add`, `rm`). The file is the only
  thing shared with the daemon, so hand edits and `./frproxy add` behave identically.
- `src/daemon.ts`: the Cloudflare work (zones, tunnel, ingress, CNAMEs), the sync loop and the command table. It only reads the config.
- `cloudflared`: runs on the host network so `localhost:PORT` reaches your apps; the daemon hands it the tunnel token through a shared volume.
- `config/.secrets.yml`: the Cloudflare API token (git-ignored, read on every use).

## Notes

- Cloudflare's proxy sees all traffic in plaintext. One label below the zone only (`a.domain`, not `a.b.domain`).
- Works with docker compose, podman-compose and rootless podman (the wrapper picks whichever it finds; set `FRPROXY_COMPOSE`
  to force one). In rootless podman the container's `root` is just your user, so files in `config/` stay yours. To have the
  stack start at boot, `apply` enables `podman-restart.service` and linger for your user (podman ignores
  `restart: unless-stopped` across reboots otherwise).
- The API token lives in `config/.secrets.yml`; scope it as above and revoke it if it leaks.
