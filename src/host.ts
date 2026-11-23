// Setup of the machine running cfproxy, done through what compose.yaml mounts from it: its bin directory (at the same
// path, so paths written here are valid on the host), ~/.ssh and compose.yaml. The ./cfproxy script passes the rest in
// CFPROXY_* variables. Keeping the stack up across reboots is systemd's business and stays in the script.
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { API, SECRETS_PATH, fail, loadConfig, loadSecrets, namedTunnels, own, serviceUrl } from "./config";

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
  own(`${bin()}/cfproxy`);
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
    own(SECRETS_PATH);
    return console.log("saved to config/.secrets.yml"), true;
  }
}

// --- cloudflared, for ssh through a tunnel ---

// Downloads the release compose.yaml pins, built for the host's OS and CPU, unless it is already there.
export async function installCloudflared() {
  const path = `${bin()}/cloudflared`;
  if (existsSync(path)) return path;
  const version = readFileSync("/host/cfproxy/compose.yaml", "utf8").match(/cloudflare\/cloudflared:([\d.]+)/)![1];
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
  own(`${path}.tmp`);
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

// Match evaluates only `host` and `all`; other criteria (exec, user, ...) count as met, so when in doubt a setting is
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

// ~/.ssh/config as the container sees it: a symlink to a file outside ~/.ssh cannot be followed from here.
function readSshConfig() {
  if (lstatSync(SSH_CONFIG, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(SSH_CONFIG))
    fail("~/.ssh/config is a symlink to a file outside ~/.ssh, which cfproxy cannot reach from its container");
  return existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, "utf8") : "";
}

// The files an Include names that the container can see: those under ~/.ssh, where relative paths start.
function includedFiles(pattern: string) {
  const rel = pattern.match(/^(?:~|\/.*)?\/\.ssh\/(.*)$/)?.[1] ?? (/^[~/]/.test(pattern) ? undefined : pattern);
  const path = `/host/ssh/${rel}`;
  if (rel === undefined || !existsSync(dirname(path))) return [];
  if (!/[*?]/.test(basename(path))) return existsSync(path) ? [path] : [];
  return readdirSync(dirname(path)).filter((f) => glob(basename(path)).test(f)).map((f) => `${dirname(path)}/${f}`);
}

// cfproxy's own block for name, found by its note (as any cfproxy version wrote it) and Host line, up to the next blank
// line, Host, Match or cfproxy note. Lines someone added to it belong to it.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ownBlock = (name: string) =>
  new RegExp(`(?:^|\\n)# added by cfproxy: (?:cfproxy ssh )?${escape(name)}[ =][^\\n]*\\nHost ${escape(name)}\\r?(?:\\n|$)(?:(?![ \\t]*(?:host\\b|match\\b|# added by cfproxy))[ \\t]*\\S[^\\n]*(?:\\n|$))*`, "gi");

// What ssh takes for host from ~/.ssh/config, first value wins like in ssh: its HostName, and its ProxyCommand or
// ProxyJump (`none` included). Includes under ~/.ssh are followed. With others, cfproxy's own block for host is left
// out, so what remains is someone else's.
function sshSettings(host: string, others = false) {
  const found: { hostname?: string; proxy?: string } = {};
  let applies = true; // lines before the first Host or Match apply to every host
  const visit = (text: string, depth: number): void => {
    for (const line of text.split(/\r?\n/)) {
      const [key = "", ...values] = line.trim().replace(/^(\w+)\s*=\s*/, "$1 ").match(/"[^"]*"|\S+/g) ?? [];
      const name = key.toLowerCase();
      if (name === "include" && applies && depth < 16) {
        for (const file of values.flatMap(includedFiles)) visit(readFileSync(file, "utf8"), depth + 1);
        applies = true; // back in the block that included them, which applies
      } else if (name === "host") applies = hostMatches(host, values);
      else if (name === "match") applies = matchApplies(host, values);
      else if (applies && name === "hostname") found.hostname ??= values[0];
      else if (applies && (name === "proxycommand" || name === "proxyjump")) found.proxy ??= values.join(" ");
    }
  };
  const text = readSshConfig();
  visit(others ? text.replace(ownBlock(host), "") : text, 0);
  return found;
}

// Writes cfproxy's block for name in place of its earlier one (and drops duplicates), keeping lines someone added to
// it, or appends it.
function writeBlock(name: string, note: string, settings: string[]) {
  const text = readSshConfig();
  const added = [...text.matchAll(ownBlock(name))].flatMap((m) => m[0].replace(/^\n/, "").split(/\r?\n/).slice(2));
  const keep = [...new Set(added.filter((line) => line.trim() && !/^\s*(hostname|user|proxycommand)\b/i.test(line)))];
  const block = `${[`# added by cfproxy: ${name} ${note}`, `Host ${name}`, ...settings.map((s) => `  ${s}`), ...keep].join("\n")}\n`;
  let first = true;
  const replaced = text.replace(ownBlock(name), (m) => (first ? ((first = false), `${m.startsWith("\n") ? "\n" : ""}${block}`) : ""));
  const next = first ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}` : replaced;
  if (next !== text) writeFileSync(SSH_CONFIG, next, { mode: 0o600 }), own(SSH_CONFIG);
}

// Whether host is served through Cloudflare: its edge answers /cdn-cgi/trace for every hostname it proxies.
const behindCloudflare = (host: string) =>
  fetch(`https://${host}/cdn-cgi/trace`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).then((t) => t.includes(`h=${host}\n`), () => false);

// Why plain `ssh host` will not work from this machine; empty when it will.
export function sshProblems(host: string) {
  const { proxy } = sshSettings(host);
  return [
    !existsSync(`${bin()}/cloudflared`) && "cloudflared is not installed",
    !proxy ? "~/.ssh/config has no ProxyCommand for it" : !proxy.includes("cloudflared") && `~/.ssh/config gives it another proxy (${proxy})`,
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

// `cfproxy ssh nas=[user@]<host>`: a fixed alias for ssh, scp, rsync and git, to a hostname on your domain or a quick
// tunnel's <words>[.trycloudflare.com]. A quick tunnel's hostname changes whenever it restarts: running it again with
// the new one updates the alias in place.
export const isAlias = (arg = "") => /^[^-=@][^=@]*=/.test(arg);

export async function setupAlias(arg: string) {
  const [alias = "", dest = "", ...more] = arg.split("=");
  const [, user, target] = (!more.length && dest.match(/^(?:([\w.-]+)@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)$/)) || [];
  const name = alias.toLowerCase();
  if (!/^[\w-]+$/.test(name) || !target) fail(`'${arg}': use alias=[user@]<words>[.trycloudflare.com] or alias=[user@]<hostname>`);
  const hostname = target.includes(".") ? target.toLowerCase() : `${target.toLowerCase()}.trycloudflare.com`;
  const theirs = sshSettings(name, true);
  if (theirs.hostname || theirs.proxy)
    fail(`~/.ssh/config already has settings for ${name} (${theirs.hostname ? `HostName ${theirs.hostname}` : `proxy ${theirs.proxy}`}); pick another alias, or remove them first`);
  const proxy = `ProxyCommand ${await installCloudflared()} access ssh --hostname %h`;
  writeBlock(name, `is an alias (./cfproxy ssh ${name}=<new hostname> updates it)`, [`HostName ${hostname}`, ...(user ? [`User ${user}`] : []), proxy]);
  console.log(`${name} -> ${user ? `${user}@` : ""}${hostname} in ~/.ssh/config: ssh ${name}, scp and rsync work with it`);
}

// Makes plain `ssh <host>` work here (by default for every SSH tunnel in the config): cloudflared, plus a ProxyCommand
// block in ~/.ssh/config unless someone else's settings give the host a HostName or proxy (`none` included). A host that
// is not one of this machine's tunnels is only added if Cloudflare serves it, so ssh to other hosts keeps working.
export async function setupSsh(hosts = sshHosts()) {
  for (const host of hosts) {
    const theirs = sshSettings(host, true);
    if (theirs.proxy?.includes("cloudflared") || ownBlock(host).test(readSshConfig())) {
      await installCloudflared();
      continue;
    }
    if (theirs.hostname || theirs.proxy) {
      console.log(`${host} has its own ${theirs.proxy ? "ProxyCommand or ProxyJump" : "HostName"} in ~/.ssh/config; left it alone`);
      continue;
    }
    // A name without a dot is a quick tunnel's name, which only its own machine knows the hostname for.
    if (!host.includes(".")) fail(`${host} is not set up for ssh here yet: run ./cfproxy ssh ${host}=[user@]<its hostname> (add prints it)`);
    if (!sshHosts().includes(host) && !(await behindCloudflare(host))) {
      console.log(`${host} is not served through Cloudflare; ~/.ssh/config is left alone for it`);
      continue;
    }
    writeBlock(host, "is an SSH tunnel through Cloudflare", [`ProxyCommand ${await installCloudflared()} access ssh --hostname %h`]);
    console.log(`added ${host} to ~/.ssh/config, so plain ssh to it works from this machine`);
  }
}
