// The config file is the only thing shared between the CLI helpers and the Cloudflare daemon:
// both go through normalize(), so an entry behaves the same however it got into the file.
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Tunnels = Record<string, string | number>;
export type Config = { tunnels: Tunnels; name?: string; accountId?: string };

export const API = "https://api.cloudflare.com/client/v4";
export const CONFIG_PATH = "/config/cfproxy.yml";
export const SECRETS_PATH = "/config/.secrets.yml";
const HEADER = `# Edit and save: changes to hostnames apply within seconds, to quick tunnels after ./cfproxy apply.

# hostname -> where to send traffic: a port, host:port or a URL.
# A name without a dot is a quick tunnel: a random https://....trycloudflare.com URL, no domain needed.
`;

export class Fail extends Error {}
export const fail = (msg: string): never => {
  throw new Fail(msg);
};

// A syntax error from a hand edit must not kill the daemon: it is reported and retried like any other Fail.
// A missing file is empty, so a fresh checkout can start with `./cfproxy add` (which creates it).
function readYaml(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return Bun.YAML.parse(readFileSync(path, "utf8")) ?? {};
  } catch (e: any) {
    return fail(`${path}: ${e.message}`);
  }
}

const isPort = (addr: string | number) => /^\d+$/.test(String(addr));

// Where cloudflared should send a tunnel's traffic: a bare port means localhost.
// A bare port or host:port is HTTP, except port 22, which is SSH; a full URL is used as written.
export const serviceUrl = (addr: string | number) => {
  const text = String(addr);
  if (text.includes("://")) return text;
  const target = isPort(addr) ? `127.0.0.1:${addr}` : text;
  return `${/:22$/.test(target) ? "ssh" : "http"}://${target}`;
};

// A name without a dot is a quick tunnel (TryCloudflare): Cloudflare picks its hostname each time it starts, and the
// name only identifies it here. Names with dots are hostnames in your zones, served by this machine's named tunnel.
export const isQuick = (name: string) => !name.includes(".");
export const namedTunnels = (tunnels: Tunnels) => Object.entries(tunnels).filter(([name]) => !isQuick(name));

// The name `add` gives a quick tunnel when none is given: port-3000 for a bare port, else the address made safe.
export const defaultName = (addr: string) => {
  const target = addr.replace(/^:/, "");
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return isPort(target) ? `port-${slug}` : slug;
};

function normalize(host: string, addr: string | number): [string, string | number] {
  const hostname = host.toLowerCase();
  if (hostname.endsWith(".example.com")) fail(`Replace the example hostname ${hostname} in config/cfproxy.yml with your own domain.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostname) && !/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(hostname))
    fail(`'${host}': use a full hostname like name.example.com, or a name without dots (like myapp) for a quick tunnel`);

  const target = String(addr).replace(/^:/, "");
  if (!/^(\d+|[\w.-]+:\d+|\w+:\/\/\S+)$/.test(target)) fail(`${hostname}: bad address '${addr}' (use PORT, HOST:PORT or a URL)`);
  return [hostname, isPort(target) ? Number(target) : target];
}

const normalizeAll = (raw: object | undefined): Tunnels =>
  Object.fromEntries(Object.entries(raw ?? {}).map(([host, addr]) => normalize(host, addr as string | number)));

export function loadConfig(): Config {
  const raw = readYaml(CONFIG_PATH);
  const name = raw.name == null ? undefined : String(raw.name).toLowerCase();
  if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`name '${raw.name}': use lowercase letters, digits and dashes`);
  return { tunnels: normalizeAll(raw.tunnels), name, accountId: raw.account_id == null ? undefined : String(raw.account_id) };
}

// Each machine owns one Cloudflare tunnel, cfproxy-<name>, so several machines can share an account.
// The name defaults to the host's hostname; `name:` in cfproxy.yml overrides it.
export function tunnelName(name?: string) {
  if (name) return `cfproxy-${name}`;
  const suffix = (process.env.CFPROXY_HOSTNAME ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `cfproxy-${suffix || fail("Could not read this machine's hostname; set `name:` in config/cfproxy.yml")}`;
}

// Read on every use, so a token pasted into the file is picked up without restarting anything.
export function loadSecrets() {
  const raw = existsSync(SECRETS_PATH) ? readYaml(SECRETS_PATH) : {};
  return { apiToken: raw.cloudflare?.api_token ? String(raw.cloudflare.api_token) : undefined };
}

function saveConfig(raw: object) {
  const text = `${HEADER}${Bun.YAML.stringify(raw, null, 2)}\n`;
  if (existsSync(CONFIG_PATH)) {
    if (readFileSync(CONFIG_PATH, "utf8") === text) return;
    const numbers = readdirSync(dirname(CONFIG_PATH)).map((f) => Number(f.match(/^cfproxy\.yml\.(\d+)\.bak$/)?.[1] ?? 0));
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${Math.max(0, ...numbers) + 1}.bak`);
  }
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, CONFIG_PATH); // atomic: the daemon never sees a half-written file
}

const LOCK = `${CONFIG_PATH}.lock`;

// Serializes read-modify-write cycles so concurrent commands don't overwrite each other's entries.
// A lock is never removed automatically: guessing that one is stale is itself racy.
async function withLock<T>(fn: () => T): Promise<T> {
  for (let waited = 0; ; waited += 50) {
    try {
      closeSync(openSync(LOCK, "wx"));
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (waited >= 5_000) fail("config/cfproxy.yml.lock exists; if no other cfproxy command is running, delete it and try again");
      await Bun.sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK, { force: true });
  }
}

// Browsers only speak HTTP(S) to a tunnel hostname; anything else needs `cloudflared access` on the client.
// Not for quick tunnels: their hostname is only known once they run (add prints the client command for SSH then).
export function clientHints(hosts: { hostname: string; service: string }[]) {
  const lines: string[] = [];
  for (const { hostname, service } of hosts) {
    const scheme = service.split("://")[0];
    if (scheme === "http" || scheme === "https" || isQuick(hostname)) continue;
    lines.push(`${hostname} is ${scheme}, not HTTP. Clients need cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):`);
    if (scheme === "ssh")
      lines.push(`  on a client with this repo: ./cfproxy ssh user@${hostname}   (installs cloudflared if needed)`, "  or set up plain ssh on the client:", "", "mkdir -p ~/.ssh && cat >> ~/.ssh/config <<EOF", `Host ${hostname}`, "  ProxyCommand cloudflared access ssh --hostname %h", "EOF", "", `  then: ssh user@${hostname}`);
    else lines.push(`  cloudflared access ${scheme} --hostname ${hostname} --url localhost:<port>`, `  then connect your client to localhost:<port>`);
  }
  return lines;
}

// Only `tunnels` is rewritten; other keys (name, account_id) are carried over untouched.
const edit = (change: (tunnels: Tunnels) => string) =>
  withLock(() => {
    const raw = readYaml(CONFIG_PATH);
    const tunnels = normalizeAll(raw.tunnels);
    const message = change(tunnels);
    saveConfig({ ...raw, tunnels });
    console.log(message);
  });

export const add = async ([addr, name = defaultName(addr)]: string[]) => {
  let hints: string[] = [];
  await edit((tunnels) => {
    const [host, target] = normalize(name, addr);
    tunnels[host] = target;
    hints = clientHints([{ hostname: host, service: serviceUrl(target) }]);
    return isQuick(host) ? `quick tunnel ${host} -> ${serviceUrl(target)}` : `https://${host} -> ${serviceUrl(target)}`;
  });
  for (const line of hints) console.log(line);
};

export const rm = ([name]: string[]) =>
  edit((tunnels) => {
    const host = name.toLowerCase();
    if (!(host in tunnels)) fail(`no tunnel for ${name}`);
    delete tunnels[host];
    return isQuick(host) ? `removed quick tunnel ${host}` : `removed https://${host}`;
  });
