import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { API, CONFIG_PATH, SECRETS_PATH, Fail, add, fail, loadConfig, loadSecrets, clientHints, namedTunnels, rm, serviceUrl, tunnelName, type Config } from "./config";
import * as quick from "./quick";
import { TOKEN_STEPS, askToken, isAlias, link, setupAlias, setupSsh, sshDestination, sshHosts, sshProblems } from "./host";

const TOKEN_FILE = "/state/token";
const OWN_PREFIX = "cfproxy-";

const TOKEN_HELP = `${TOKEN_STEPS}
    4. Run ./cfproxy install, which asks for it, or put it in config/.secrets.yml (see .secrets.yml.example);
       it is re-read automatically.`;

// --- Cloudflare API ---

async function cf(path: string, init: RequestInit = {}) {
  const token = loadSecrets().apiToken ?? fail(`No Cloudflare API token in config/.secrets.yml.\n${TOKEN_HELP}`);
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!body.success) fail(`Cloudflare API error on ${init.method ?? "GET"} ${path}: ${JSON.stringify(body.errors)}\n${TOKEN_HELP}`);
  return body.result;
}
const send = (method: string, body?: object) => ({ method, body: body && JSON.stringify(body) });

// Prints a change; runs it only when applying.
const makeAct = (apply: boolean) => async (msg: string, change: () => Promise<unknown>) => {
  console.log(`${apply ? "" : "(plan) "}${msg}`);
  if (apply) await change();
};

// --- what exists on Cloudflare now ---

type Zone = { id: string; name: string; status: string; name_servers: string[]; account: { id: string } };

async function listZones() {
  const zones = new Map<string, Zone>();
  for (let page = 1; ; page++) {
    const batch: Zone[] = await cf(`/zones?per_page=50&page=${page}`);
    for (const zone of batch) zones.set(zone.name, zone);
    if (batch.length < 50) return zones;
  }
}

async function findAccount(zones: Map<string, Zone>, configured?: string) {
  if (configured) return configured;
  const accounts = [...new Set([...zones.values()].map((z) => z.account.id))];
  if (accounts.length > 1) fail("Your zones span several Cloudflare accounts; set account_id in config/cfproxy.yml to the one cfproxy should use.");
  if (accounts.length === 1) return accounts[0];
  const found = await cf("/accounts").catch(() => []);
  return found.length === 1 ? found[0].id : undefined;
}

const requireAccount = (account?: string) =>
  account ??
  fail(`Could not work out your Cloudflare account ID.
  Set account_id in config/cfproxy.yml (dash.cloudflare.com -> any domain -> Overview -> API section -> Account ID),
  or give the token Account | Account Settings | Read.`);

// A tunnel's DNS name and back again; the CNAME content is how DNS records are matched to tunnels.
const CNAME_SUFFIX = ".cfargotunnel.com";
const cnameTarget = (tunnel?: { id: string }) => `${tunnel?.id ?? "<new tunnel>"}${CNAME_SUFFIX}`;
const tunnelIdOf = (content: string) => (content.endsWith(CNAME_SUFFIX) ? content.slice(0, -CNAME_SUFFIX.length) : "");
const recordFor = (records: Map<string, any[]>, { hostname, zone }: { hostname: string; zone: string }) => records.get(zone)?.find((r) => r.name === hostname);

async function observe({ tunnels, name, accountId }: Config) {
  const zones = await listZones();
  const account = await findAccount(zones, accountId);
  const ownName = tunnelName(name);

  const wanted = namedTunnels(tunnels).map(([hostname, addr]) => {
    const known = [...zones.keys()].filter((name) => hostname.endsWith(`.${name}`)).sort((a, b) => b.length - a.length)[0];
    const zone = known ?? hostname.split(".").slice(-2).join(".");
    if (hostname.slice(0, -zone.length - 1).includes(".")) fail(`${hostname}: must be one label below its zone ${zone} (Cloudflare's free certificate covers one level)`);
    return { hostname, zone, service: serviceUrl(addr) };
  });

  const tunnelsPath = account && `/accounts/${account}/cfd_tunnel`;
  const allTunnels: any[] = tunnelsPath ? await cf(`${tunnelsPath}?is_deleted=false&per_page=1000`) : [];
  const tunnel = allTunnels.find((t) => t.name === ownName);
  const others = new Map(allTunnels.filter((t) => t.name.startsWith(OWN_PREFIX) && t.name !== ownName).map((t) => [t.id, t.name]));
  const ingress: any[] = tunnel ? ((await cf(`${tunnelsPath}/${tunnel.id}/configurations`))?.config?.ingress ?? []) : [];
  const records = new Map<string, any[]>();
  for (const zone of zones.values()) records.set(zone.name, await cf(`/zones/${zone.id}/dns_records?type=CNAME&per_page=1000`));

  // `owner` is another machine's cfproxy tunnel that already serves this hostname.
  const hosts = wanted.map((host) => {
    return { ...host, owner: others.get(tunnelIdOf(recordFor(records, host)?.content ?? "")) };
  });

  return { zones, account, tunnelName: ownName, tunnelsPath, tunnel, ingress, records, hosts };
}

const nameserverNote = (zone: Zone) => `zone ${zone.name} is ${zone.status}: set these nameservers at your registrar: ${zone.name_servers.join(" ")}`;
const ingressKey = (rules: any[]) => JSON.stringify(rules.map((r) => [r.hostname, r.service]));

// --- making Cloudflare match the config ---

// Without a token and without hostnames there is nothing on Cloudflare to sync: quick tunnels need no account.
// With a token it still runs, so removing the last hostname cleans up its DNS record and ingress rule.
const usesCloudflare = (config: Config) => !!loadSecrets().apiToken || namedTunnels(config.tunnels).length > 0;

// With apply=false only prints what would change. Returns whether a zone still needs its nameservers set.
async function reconcile(config: Config, apply: boolean) {
  if (!usesCloudflare(config)) return false;
  const act = makeAct(apply);
  let state = await observe(config);

  // Checked before anything changes, so a conflict never leaves a half-applied sync.
  const taken = state.hosts.filter((h) => h.owner);
  if (taken.length) fail(taken.map((h) => `${h.hostname} is already served by tunnel ${h.owner}: remove it from that machine's config first`).join("\n"));

  const wantedZones = [...new Set(state.hosts.map((h) => h.zone))];
  const missingZones = wantedZones.filter((name) => !state.zones.has(name));
  for (const name of missingZones)
    await act(`+ zone ${name}`, () => cf("/zones", send("POST", { name, account: { id: requireAccount(state.account) }, type: "full" })));
  if (apply && missingZones.length) state = await observe(config);

  if (!state.tunnel) {
    await act(`+ tunnel ${state.tunnelName}`, () => cf(`/accounts/${requireAccount(state.account)}/cfd_tunnel`, send("POST", { name: state.tunnelName, config_src: "cloudflare" })));
    if (apply) state = await observe(config);
  }

  const pendingZones = wantedZones.map((name) => state.zones.get(name)).filter((z): z is Zone => !!z && z.status !== "active");
  for (const zone of pendingZones) {
    console.log(nameserverNote(zone));
    if (apply) await cf(`/zones/${zone.id}/activation_check`, send("PUT")).catch(() => {});
  }

  await syncIngress(state, act);
  await syncRecords(state, act);

  if (apply) {
    const token: string = await cf(`${state.tunnelsPath}/${state.tunnel.id}/token`);
    if (!existsSync(TOKEN_FILE) || readFileSync(TOKEN_FILE, "utf8") !== token) writeFileSync(TOKEN_FILE, token, { mode: 0o644 });
  }
  return pendingZones.length > 0 || missingZones.length > 0;
}

type State = Awaited<ReturnType<typeof observe>>;
type Act = ReturnType<typeof makeAct>;

async function syncIngress({ hosts, ingress, tunnel, tunnelsPath }: State, act: Act) {
  const rules = [...hosts.map(({ hostname, service }) => ({ hostname, service })), { service: "http_status:404" }];
  if (ingressKey(ingress) === ingressKey(rules)) return;
  const list = hosts.map((h) => `${h.hostname} -> ${h.service}`).join(", ") || "(none)";
  await act(`~ ingress: ${list}`, () => cf(`${tunnelsPath}/${tunnel.id}/configurations`, send("PUT", { config: { ingress: rules } })));
}

async function syncRecords({ hosts, zones, records, tunnel }: State, act: Act) {
  const target = cnameTarget(tunnel);
  const wanted = new Set(hosts.map((h) => h.hostname));
  const recordsUrl = (zone: string) => `/zones/${zones.get(zone)!.id}/dns_records`;

  for (const host of hosts) {
    const { hostname, zone } = host;
    const record = recordFor(records, host);
    const body = { type: "CNAME", name: hostname, content: target, proxied: true };
    if (!record) await act(`+ CNAME ${hostname}`, () => cf(recordsUrl(zone), send("POST", body)));
    else if (record.content !== target || !record.proxied) await act(`~ CNAME ${hostname}`, () => cf(`${recordsUrl(zone)}/${record.id}`, send("PUT", body)));
  }
  for (const [zone, zoneRecords] of records)
    for (const record of zoneRecords.filter((r) => r.content === target && !wanted.has(r.name)))
      await act(`- CNAME ${record.name}`, () => cf(`${recordsUrl(zone)}/${record.id}`, send("DELETE")));
}

async function status(config: Config) {
  if (usesCloudflare(config)) await namedStatus(config);
  await quick.printStatus();
  for (const host of sshHosts()) {
    const problems = sshProblems(host);
    console.log(`ssh ${host} from this machine: ${problems ? `will not work: ${problems} (./cfproxy apply fixes it, or use ./cfproxy ssh)` : "ok"}`);
  }
}

async function namedStatus(config: Config) {
  const { zones, tunnel, tunnelName, ingress, records, hosts } = await observe(config);
  for (const name of new Set(hosts.map((h) => h.zone))) {
    const zone = zones.get(name);
    console.log(!zone ? `zone ${name}: missing` : zone.status === "active" ? `zone ${name}: active` : nameserverNote(zone));
  }
  console.log(tunnel ? `tunnel ${tunnelName}: ${tunnel.status} (${tunnel.id})` : `tunnel ${tunnelName}: missing`);
  for (const host of hosts) {
    const { hostname, service, owner } = host;
    const record = recordFor(records, host);
    const dns = !record ? "missing" : owner ? `served by ${owner}` : record.content === cnameTarget(tunnel) ? "ok" : "wrong target";
    const route = ingress.some((r) => r.hostname === hostname && r.service === service) ? "ok" : "missing";
    const note = clientHints([host]).length ? " [client needs cloudflare]" : "";
    console.log(`https://${hostname} -> ${service}   dns: ${dns}, ingress: ${route}${note}`);
  }
}

// --- buying a domain ---

// The purchase page with the domain already searched; without a known account, the generic registrar page.
const buyUrl = (domain: string, account?: string) =>
  account ? `https://dash.cloudflare.com/${account}/domains/registrations/purchase?query=${encodeURIComponent(domain)}` : "https://dash.cloudflare.com/?to=/:account/registrar/register";
const cleanDomain = (input: string) => {
  const domain = input.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`'${input}': use a plain domain like example.com`);
  return domain;
};

// For the ./cfproxy wrapper, which opens the browser: prints the purchase URL, exits 1 if the domain is already ours.
async function buyLink([input]: string[]) {
  const domain = cleanDomain(input);
  const zones = await listZones();
  if (zones.has(domain)) process.exit(1);
  console.log(buyUrl(domain, await findAccount(zones, loadConfig().accountId).catch(() => undefined)));
}
const BUY_WAIT_MS = 15 * 60_000;

// The first line of a failure only: the token help that cf() appends is noise here.
const brief = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

// Opening the browser happens in the ./cfproxy wrapper (the container has none); this checks the price,
// then waits until the domain shows up in the account. Exits 0 only once it is ours, so `buy x && add ...` is safe.
async function buy([input]: string[]) {
  const domain = cleanDomain(input);
  const zones = await listZones();
  if (zones.has(domain)) return console.log(`${domain} is already in your Cloudflare account (zone ${zones.get(domain)!.status})`);

  const account = await findAccount(zones, loadConfig().accountId).catch(() => undefined);
  if (account) {
    // Best effort: needs a token with Registrar permissions, and the API only covers some TLDs.
    await cf(`/accounts/${account}/registrar/domain-check`, send("POST", { domains: [domain] })).then(
      (result) => {
        const info = result?.domains?.[0] ?? result?.[0];
        if (info?.registrable === false) fail(`${domain} is not available to register`);
        const price = info?.pricing;
        if (price) console.log(`${domain}: ${price.registration_cost ?? "?"} ${price.currency ?? ""} for the first year`.trim());
      },
      (e) => {
        if (e instanceof Fail && e.message.includes("not available")) throw e;
        console.log(`(could not check availability: ${brief(e)})`);
      },
    );
  }
  console.log(`Purchase it in the browser, and I will carry on once it is in your account. Waiting up to 15 minutes...\nBuy ${domain} here:\n${buyUrl(domain, account)}`);

  for (const until = Date.now() + BUY_WAIT_MS; Date.now() < until; await Bun.sleep(5000)) {
    let zone = (await listZones()).get(domain);
    if (!zone && account) {
      // Registered through Cloudflare Registrar but not a zone yet: adding the zone is instant, nameservers are already ours.
      const owned: { name: string }[] = await cf(`/accounts/${account}/registrar/domains`).catch(() => []);
      if (owned.some((d) => d.name === domain)) zone = await cf("/zones", send("POST", { name: domain, account: { id: account }, type: "full" }));
    }
    if (zone) return console.log(`${domain} is yours: zone ${zone.status}. Next: ./cfproxy add <port> name.${domain}`);
  }
  fail(`${domain} did not show up in your account within 15 minutes; run ./cfproxy buy ${domain} again after purchasing`);
}

// --- the daemon loop and commands ---

// Both files are watched, so saving a new token wakes the loop just like editing a hostname does.
const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0);
const stamp = () => `${mtime(CONFIG_PATH)}:${mtime(SECRETS_PATH)}`;

async function run() {
  let lastError = "";
  for (;;) {
    const seen = stamp();
    let delay = 300_000;
    try {
      if (await reconcile(loadConfig(), true)) delay = 30_000;
      delay = Math.min(delay, quick.notePending(Date.now() - mtime(CONFIG_PATH)) ?? delay);
      lastError = "";
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      if (e.message !== lastError) console.error(e.message);
      lastError = e.message;
      delay = 30_000;
    }
    for (const until = Date.now() + delay; Date.now() < until && stamp() === seen; ) await Bun.sleep(2000);
  }
}

async function apply() {
  const config = loadConfig();
  const waiting = await reconcile(config, true);
  await setupSsh();
  console.log(waiting ? "waiting on nameservers; the background daemon keeps checking and finishes setup once the zone is active" : "everything is in order");
}

type Command = { args: string; desc: string; run: (args: string[]) => Promise<unknown> | void };
const commands: Record<string, Command> = {
  run: { args: "", desc: "keep Cloudflare in sync with config/cfproxy.yml (what the background container runs)", run },
  apply: { args: "", desc: "sync Cloudflare once; ./cfproxy apply then keeps the stack running", run: apply },
  plan: { args: "", desc: "show what apply would change, change nothing", run: async () => (await reconcile(loadConfig(), false), quick.printPlan()) },
  owns: { args: "<domain>", desc: "exit 0 if <domain> is already a zone in your account", run: async ([domain]) => { if (!(await listZones()).has(domain.toLowerCase())) process.exit(1); } },
  buyurl: { args: "<domain>", desc: "print the Cloudflare purchase URL for <domain> (used by buy)", run: buyLink },
  buy: { args: "<domain>", desc: "open Cloudflare Registrar to buy <domain>, then wait until it is in your account", run: buy },
  status: { args: "", desc: "show zone, tunnel and per-tunnel state", run: () => status(loadConfig()) },
  add: { args: "<addr> [hostname]", desc: "expose :PORT, HOST:PORT or a URL at https://<hostname>; a name without dots (or none) is a quick tunnel", run: async (args) => (await add(args), setupSsh()) },
  rm: { args: "<hostname>", desc: "stop exposing <hostname> (or quick tunnel name)", run: rm },
  compose: { args: "", desc: "write config/compose.tunnels.yaml.new, the cloudflared containers (used by add, rm and apply)", run: quick.writeCompose },
  url: { args: "<addr> [hostname]", desc: "wait for the URL of the quick tunnel add just started, and print it", run: quick.printUrl },
  serves: { args: "", desc: "exit 0 if this machine has something to serve (a token or a quick tunnel)", run: () => { if (!loadSecrets().apiToken && !quick.hasQuickTunnels()) process.exit(1); } },
  install: { args: "", desc: "link cfproxy into ~/.local/bin, ask for the Cloudflare API token, then start like apply", run: async () => (link(), askToken()) },
  ssh: { args: "[alias=<quick tunnel>] <ssh args...>", desc: "set up plain ssh to a tunnel on this machine (cloudflared, ~/.ssh/config), then run ssh with the args; alias=<words>[.trycloudflare.com] names a quick tunnel (ssh args optional)", run: (args) => (isAlias(args[0]) ? setupAlias(args[0]) : setupSsh([sshDestination(args)])) },
  help: { args: "", desc: "show this help", run: () => console.log(usage()) },
};

function usage() {
  const rows = Object.entries(commands).map(([name, c]) => [`${name} ${c.args}`.trim(), c.desc]);
  const width = Math.max(...rows.map(([label]) => label.length));
  return `usage: cfproxy <command>\n${rows.map(([label, desc]) => `  ${label.padEnd(width + 2)}${desc}`).join("\n")}`;
}

// Arguments are taken as they are, so `ssh` gets its options (-N, -L ...) untouched.
const [given = "run", ...args] = process.argv.slice(2);
const name = given === "-h" || given === "--help" ? "help" : given;
const command = commands[name];
// "..." marks a command that takes any arguments, [brackets] an optional one.
const params = command?.args.split(" ").filter(Boolean) ?? [];
if (!command || (!command.args.includes("...") && (args.length < params.filter((p) => !p.startsWith("[")).length || args.length > params.length))) {
  console.error(command ? `usage: cfproxy ${name} ${command.args}` : usage());
  process.exit(1);
}

// bun is PID 1 in the container, and PID 1 ignores signals that have no handler: without this Ctrl-C does nothing.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));

try {
  await command.run(args);
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(e.message);
  process.exit(1);
}
