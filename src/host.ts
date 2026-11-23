// Setup of the machine running cfproxy, done through what compose.yaml mounts from it: its bin directory (at the same
// path, so paths written here are valid on the host), ~/.ssh and compose.yaml. The ./cfproxy script passes the rest in
// CFPROXY_* variables. Keeping the stack up across reboots is systemd's business and stays in the script.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { API, SECRETS_PATH, fail, loadConfig, loadSecrets, namedTunnels, serviceUrl } from "./config";

const SSH_CONFIG = "/host/ssh/config";
const env = (name: string) => process.env[name] || fail(`${name} is not set: run cfproxy through the ./cfproxy script`);
const bin = () => env("CFPROXY_BIN");

export const TOKEN_STEPS = `
  Create a Cloudflare API token:
    1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Create Custom Token
       (an account token, from Manage Account -> API Tokens, works too)
    2. Permissions:
         Account | Cloudflare Tunnel | Edit
         Zone    | Zone              | Edit
         Zone    | DNS               | Edit
         Account | Account Settings  | Read    (only if you do not set account_id in config/cfproxy.yml)
    3. Account Resources: Include -> your account.  Zone Resources: Include -> All zones
       (a single zone works once the domain is already on Cloudflare)`;

// --- install ---

export function link() {
  const target = `${env("CFPROXY_DIR")}/cfproxy`;
  rmSync(`${bin()}/cfproxy`, { force: true });
  symlinkSync(target, `${bin()}/cfproxy`);
  console.log(`linked ${bin()}/cfproxy -> ${target}`);
  if (!env("CFPROXY_PATH").split(":").includes(bin()))
    console.log(`${bin()} is not in your PATH; add it:\n  fish:      fish_add_path ${bin()}\n  bash/zsh:  echo 'export PATH="${bin()}:$PATH"' >> ~/.profile`);
}

// Reads a line without echoing it (the container has its own tty, so stty affects only that).
function askHidden(question: string) {
  const stty = (mode: string) => Bun.spawnSync(["stty", mode], { stdin: "inherit" });
  stty("-echo");
  try {
    return (prompt(question) ?? "").trim();
  } finally {
    stty("echo");
    console.log();
  }
}

// Asks until Cloudflare accepts a token, then saves it; an empty line skips (quick tunnels need none).
// Listing zones works for user and account tokens alike and needs a permission cfproxy uses.
// Returns whether there is a token now.
export async function askToken() {
  if (loadSecrets().apiToken) return true;
  if (!process.stdin.isTTY) return console.log("no Cloudflare API token yet: run ./cfproxy install in a terminal to enter it"), false;
  console.log(`\nServing your own domain from this machine needs a Cloudflare API token (quick tunnels do not).${TOKEN_STEPS}`);
  for (;;) {
    const token = askHidden("Paste the token (hidden; Enter to skip):");
    if (!token) return console.log("skipped; ./cfproxy install asks again. Without one: ./cfproxy add 3000 myapp gives a quick tunnel"), false;
    const accepted = /^[\w-]+$/.test(token) && (await fetch(`${API}/zones?per_page=1`, { headers: { Authorization: `Bearer ${token}` } })).ok;
    if (!accepted) {
      console.log("Cloudflare rejected that token (or it cannot read zones); try again");
      continue;
    }
    const example = readFileSync(`${SECRETS_PATH}.example`, "utf8");
    writeFileSync(SECRETS_PATH, example.replace(/api_token:.*/, `api_token: ${token}`), { mode: 0o600 });
    return console.log("saved to config/.secrets.yml"), true;
  }
}

// --- cloudflared, for ssh through a tunnel ---

// Downloads the release compose.yaml pins, built for the host's OS and CPU, unless it is already there.
export async function installCloudflared() {
  const path = `${bin()}/cloudflared`;
  if (existsSync(path)) return path;
  const version = readFileSync("/host/compose.yaml", "utf8").match(/cloudflare\/cloudflared:([\d.]+)/)![1];
  const os = env("CFPROXY_OS").toLowerCase();
  const cpu = ({ x86_64: "amd64", aarch64: "arm64", arm64: "arm64", armv7l: "arm", armv6l: "arm", i686: "386" } as Record<string, string>)[env("CFPROXY_ARCH")];
  if (!cpu || (os !== "linux" && os !== "darwin"))
    fail(`no cloudflared download for ${os} ${env("CFPROXY_ARCH")}: install it as ${path} (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)`);
  const asset = `cloudflared-${os}-${cpu}${os === "darwin" ? ".tgz" : ""}`; // macOS builds come packed
  console.error(`installing cloudflared ${version} as ${path}`);
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`);
  if (!res.ok) fail(`could not download cloudflared ${version} (${asset}): HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(`${path}.tmp`, os === "darwin" ? Bun.spawnSync(["tar", "-xzO", "cloudflared"], { stdin: bytes }).stdout : bytes, { mode: 0o755 });
  renameSync(`${path}.tmp`, path);
  return path;
}

// --- plain `ssh <host>` from this machine ---

// Quick tunnels are left out: their hostname changes on every restart, so an ~/.ssh/config entry would go stale.
export const sshHosts = () => namedTunnels(loadConfig().tunnels).filter(([, addr]) => serviceUrl(addr).startsWith("ssh://")).map(([host]) => host);

// ssh patterns: * and ?, ! negates. A host matches if some plain pattern does and no negated one does.
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "i");
const hostMatches = (host: string, patterns: string[]) =>
  patterns.some((p) => !p.startsWith("!") && glob(p).test(host)) && !patterns.some((p) => p.startsWith("!") && glob(p.slice(1)).test(host));

// Match evaluates only `host` and `all`; other criteria (exec, user, ...) count as met, so when in doubt a proxy is
// assumed and the host left alone.
function matchApplies(host: string, criteria: string[]) {
  for (let i = 0; i < criteria.length; i++) {
    const name = criteria[i].toLowerCase();
    if (["all", "canonical", "final"].includes(name)) continue; // the criteria without an argument
    const arg = criteria[++i] ?? "";
    if (name === "host" && !hostMatches(host, arg.split(","))) return false;
  }
  return true;
}

// The ProxyCommand or ProxyJump ssh uses for host: like ssh, the first one in a matching block wins. Include is not followed.
function sshProxy(host: string) {
  if (!existsSync(SSH_CONFIG)) return "";
  let applies = true; // lines before the first Host or Match apply to every host
  for (const line of readFileSync(SSH_CONFIG, "utf8").split("\n")) {
    const [key = "", ...values] = line.trim().replace(/^(\w+)\s*=\s*/, "$1 ").match(/"[^"]*"|\S+/g) ?? [];
    const name = key.toLowerCase();
    if (name === "host") applies = hostMatches(host, values);
    else if (name === "match") applies = matchApplies(host, values);
    else if (applies && (name === "proxycommand" || name === "proxyjump")) return values[0] === "none" ? "" : values.join(" ");
  }
  return "";
}

// Why plain `ssh host` will not work from this machine; empty when it will.
export function sshProblems(host: string) {
  const proxy = sshProxy(host);
  return [
    !existsSync(`${bin()}/cloudflared`) && "cloudflared is not installed",
    !proxy ? "~/.ssh/config has no ProxyCommand for it" : !proxy.includes("cloudflared") && "~/.ssh/config sends it through another proxy",
  ].filter(Boolean).join("; ");
}

// The host that ssh would connect to: its first argument that is neither an option nor an option's value.
export function sshDestination(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i].replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "");
    if (/^-[^-]*[BbcDEeFIiJLlmOoPpQRSWw]$/.test(args[i])) i++; // ends in an option that takes a value: skip it
  }
  return fail("usage: cfproxy ssh [ssh options] [user@]hostname [command]");
}

// `cfproxy ssh box=<words>[.trycloudflare.com]`: a quick tunnel's hostname changes whenever it restarts, so it gets a
// fixed alias for ssh, scp, rsync and git. Running it again with the new hostname updates the alias in place.
export const isAlias = (arg = "") => /^[^-=@][^=@]*=/.test(arg);

export async function setupAlias(arg: string) {
  const [alias, target] = arg.toLowerCase().split("=", 2);
  if (!/^[\w-]+$/.test(alias) || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(target)) fail(`'${arg}': use alias=<words> or alias=<words>.trycloudflare.com`);
  const hostname = target.includes(".") ? target : `${target}.trycloudflare.com`;
  const note = `# added by cfproxy for a quick tunnel: cfproxy ssh ${alias}=<new hostname> updates it`;
  const ours = new RegExp(`\n${note}\nHost ${alias}\n  HostName \\S+\n  ProxyCommand .*\n`);
  const text = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, "utf8") : "";
  // Someone else's settings for this alias are left alone: Host lines naming it, or a proxy that applies to it.
  const rest = text.replace(ours, "");
  const named = rest.split("\n").some((line) => /^\s*host\s/i.test(line) && line.trim().split(/\s+/).slice(1).includes(alias));
  if (rest === text && (named || sshProxy(alias))) fail(`~/.ssh/config already has settings for ${alias}; pick another alias, or remove them first`);
  const block = `\n${note}\nHost ${alias}\n  HostName ${hostname}\n  ProxyCommand ${await installCloudflared()} access ssh --hostname %h\n`;
  writeFileSync(SSH_CONFIG, `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${block}`, { mode: 0o600 });
  console.log(`${alias} -> ${hostname} in ~/.ssh/config: ssh, scp and rsync work with it (rsync -a dir/ ${alias}:dir/)`);
}

// Makes plain `ssh <host>` work here (by default for every SSH tunnel in the config): cloudflared, plus a ProxyCommand
// block in ~/.ssh/config unless ssh already proxies the host. Safe to repeat.
export async function setupSsh(hosts = sshHosts()) {
  for (const host of hosts) {
    const proxy = sshProxy(host);
    if (proxy && !proxy.includes("cloudflared")) {
      console.log(`${host} already has a ProxyCommand or ProxyJump in ~/.ssh/config; left it alone`);
      continue;
    }
    const cloudflared = await installCloudflared();
    if (proxy) continue;
    const text = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, "utf8") : "";
    const block = `\n# added by cfproxy: ${host} is an SSH tunnel through Cloudflare\nHost ${host}\n  ProxyCommand ${cloudflared} access ssh --hostname %h\n`;
    appendFileSync(SSH_CONFIG, (text && !text.endsWith("\n") ? "\n" : "") + block, { mode: 0o600 });
    console.log(`added ${host} to ~/.ssh/config, so plain ssh to it works from this machine`);
  }
}
