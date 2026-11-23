// Setup of the machine running frproxy, done through what compose.yaml mounts from it: its bin directory (at the same
// path, so paths written here are valid on the host), ~/.ssh and compose.yaml. The ./frproxy script passes the rest in
// FRPROXY_* variables. Keeping the stack up across reboots is systemd's business and stays in the script.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { API, SECRETS_PATH, fail, loadConfig, loadSecrets, serviceUrl } from "./config";

const SSH_CONFIG = "/host/ssh/config";
const env = (name: string) => process.env[name] || fail(`${name} is not set: run frproxy through the ./frproxy script`);
const bin = () => env("FRPROXY_BIN");

export const TOKEN_STEPS = `
  Create a Cloudflare API token:
    1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Create Custom Token
       (an account token, from Manage Account -> API Tokens, works too)
    2. Permissions:
         Account | Cloudflare Tunnel | Edit
         Zone    | Zone              | Edit
         Zone    | DNS               | Edit
         Account | Account Settings  | Read    (only if you do not set account_id in config/frproxy.yml)
    3. Account Resources: Include -> your account.  Zone Resources: Include -> All zones
       (a single zone works once the domain is already on Cloudflare)`;

// --- install ---

export function link() {
  const target = `${env("FRPROXY_DIR")}/frproxy`;
  rmSync(`${bin()}/frproxy`, { force: true });
  symlinkSync(target, `${bin()}/frproxy`);
  console.log(`linked ${bin()}/frproxy -> ${target}`);
  if (!env("FRPROXY_PATH").split(":").includes(bin()))
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

// Asks until Cloudflare accepts a token, then saves it; an empty line skips (machines that only use `frproxy ssh` need
// none). Listing zones works for user and account tokens alike and needs a permission frproxy uses.
// Returns whether there is a token now.
export async function askToken() {
  if (loadSecrets().apiToken) return true;
  if (!process.stdin.isTTY) return console.log("no Cloudflare API token yet: run ./frproxy install in a terminal to enter it"), false;
  console.log(`\nServing tunnels from this machine needs a Cloudflare API token (machines that only use frproxy ssh do not).${TOKEN_STEPS}`);
  for (;;) {
    const token = askHidden("Paste the token (hidden; Enter to skip):");
    if (!token) return console.log("skipped; ./frproxy install asks again"), false;
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
  const os = env("FRPROXY_OS").toLowerCase();
  const cpu = ({ x86_64: "amd64", aarch64: "arm64", arm64: "arm64", armv7l: "arm", armv6l: "arm", i686: "386" } as Record<string, string>)[env("FRPROXY_ARCH")];
  if (!cpu || (os !== "linux" && os !== "darwin"))
    fail(`no cloudflared download for ${os} ${env("FRPROXY_ARCH")}: install it as ${path} (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)`);
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

export const sshHosts = () => Object.entries(loadConfig().tunnels).filter(([, addr]) => serviceUrl(addr).startsWith("ssh://")).map(([host]) => host);

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

// Makes plain `ssh <host>` work here for every SSH tunnel: cloudflared, plus a ProxyCommand block in ~/.ssh/config
// unless ssh already proxies the host. Safe to repeat.
export async function setupSsh() {
  for (const host of sshHosts()) {
    const proxy = sshProxy(host);
    if (proxy && !proxy.includes("cloudflared")) {
      console.log(`${host} already has a ProxyCommand or ProxyJump in ~/.ssh/config; left it alone`);
      continue;
    }
    const cloudflared = await installCloudflared();
    if (proxy) continue;
    const text = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, "utf8") : "";
    const block = `\n# added by frproxy: ${host} is an SSH tunnel through Cloudflare\nHost ${host}\n  ProxyCommand ${cloudflared} access ssh --hostname %h\n`;
    appendFileSync(SSH_CONFIG, (text && !text.endsWith("\n") ? "\n" : "") + block, { mode: 0o600 });
    console.log(`added ${host} to ~/.ssh/config, so plain ssh to it works from this machine`);
  }
}
