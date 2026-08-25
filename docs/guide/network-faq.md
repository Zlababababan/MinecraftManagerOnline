# Network FAQ

**English** · [Français](fr/faq-reseau.md)

The panel listens **only** on `127.0.0.1` (or a specific address via `MMO_HOST`). Three ways to reach it from outside; one is enough.

## Tailscale (default, recommended)

**Why**: works behind CGNAT, 4G, hotel wifi, without opening any port; automatic HTTPS certificate; free plan up to 6 users (3 on some offers — check).

1. Install [Tailscale](https://tailscale.com/download) on the panel host, sign in.
2. In the panel, Settings → Remote access, **Tailscale** mode: copy and run the command shown, of the form
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
   Enable **MagicDNS** and **HTTPS certificates** in the Tailscale console if not already done.
3. The public URL becomes `https://<machine>.<tailnet>.ts.net`: enter it in Settings → General.
4. On every client device (phone, a friend's PC, a remote agent machine): install Tailscale, join the **same tailnet** (invite your friends, or share the node).
5. Run the **Reachability test** (same screen, **Run the test** button): HTTP, WebSocket, binary frames and TLS certificate (binary frames go through `tailscale serve`).

Agents: the install command uses the `https://…ts.net` URL; the agent machine therefore needs Tailscale too. Minecraft servers: **Tailnet** exposure, address `100.x.y.z:25565`.

Troubleshooting: `tailscale status` on the host; `tailscale serve status` must list the proxy (`No serve config` = the serve command was never run — the reachability test then fails with a refused connection on port 443); if the WebSocket test fails while HTTP passes, check that you do not have another proxy in front (nginx) without `Upgrade`. If PowerShell answers that `tailscale` is not recognized (Windows), the CLI is not in your PATH: call it with its full path, e.g. `& 'C:\Program Files\Tailscale\tailscale.exe' serve …` (adjust to your install folder).

## Direct (IPv6 + your own domain)

**Why**: no middleman, your friends install nothing. **Requirement**: a public IPv6 (most home boxes have one) — IPv4 behind CGNAT is not enough.

1. A domain: free with **DuckDNS** (`your-name.duckdns.org`) or a domain on Cloudflare; or any provider in **manual** mode (you create the records yourself).
2. Settings → Remote access, **Direct** mode: domain, DNS provider, token (DuckDNS: the site's token; Cloudflare: an API token with `Zone:DNS:Edit`), ACME e-mail. **Save** then **Request a certificate**: the panel creates the `_acme-challenge` TXT record (or shows it to you in manual mode), waits for propagation, obtains a Let's Encrypt certificate and opens an HTTPS listener on your global IPv6 address, port 443.
3. **Dynamic DNS**: the "Update the AAAA record automatically" switch — the panel updates the AAAA record every 10 min (DuckDNS/Cloudflare/generic URL). In manual mode, point the AAAA record at the displayed IPv6 yourself.
4. **Box / firewall**: on the box, create an IPv6 _pinhole_ (Freebox: "Ouvrir un port IPv6"; Livebox: "Pare-feu IPv6") to the host's address, port 443 TCP. On the host, add the rule shown in Settings → Remote access → **Firewall rules** (PowerShell `New-NetFirewallRule` / `ufw allow`). _Temporary_ IPv6 addresses (privacy extensions) change over time: the panel picks the stable address seen at the previous tick; when in doubt, pin it in "Public IPv6 address".
5. Public URL: `https://your-name.duckdns.org` (Settings → General), then run the **Reachability test**.

Minecraft servers: **Direct** exposure, pinhole + firewall rule per game port (shown in the same place). IPv4-only players will not be able to connect: prefer Tailscale for them.

Renewal: automatic, checked daily once < 30 days remain — except with manual DNS (the panel warns you: request the certificate again).

## Manual (existing reverse proxy)

Point your proxy (Caddy, nginx, Traefik…) at `http://127.0.0.1:3000` **with WebSocket support** (`Upgrade`/`Connection`) and frames of at least 16 MB, and forward `X-Forwarded-Proto` / `X-Forwarded-Host`. Caddy example:

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Enter the public URL and run the reachability test: the "Seen via" line of the result reads "a reverse-proxy" when the headers are forwarded correctly.

## Frequently asked questions

**The agent stays `offline` after installation.** On the machine, check the logs — Windows: `launcher.log` at the root of `%LOCALAPPDATA%\Programs\mmo-agent` and the service logs in its `logs\` subfolder; Linux: `journalctl -u mmo-agent -f` (`--user` if installed with `--user-service`); macOS: `/var/lib/mmo-agent/agent.log`. Usual causes: panel URL unreachable from that machine (Tailscale not installed/connected, firewall), certificate not trusted (manual mode with a private CA: add it to the system store), expired pairing code (the `pairing failed` message is shown during installation).

**The panel is reachable but WebSocket fails.** A proxy without `Upgrade`, or with a short idle timeout. The reachability test shows which step fails (HTTP, WebSocket, Binary frames, TLS certificate).

**Push notifications never arrive.** They require HTTPS (Tailscale or Direct) and, on iOS, installing the PWA on the home screen (Account → Push notifications walks you through it; see also [Installation § 4](installation.md#4-on-your-phone-install-the-pwa)). The "Send a test" button in the same place checks the whole chain.

**A server goes down when the agent stops or updates.** Should not happen: servers are detached and the service is configured to kill only the agent (`KillMode=process`, `AbandonProcessGroup`, shawl). If you installed a service by hand, check that setting; never use `taskkill /T` on the agent.

**IPv4 only (no IPv6 on the box).** Direct mode is impossible without a public IPv4 port forward; use Tailscale.

**Ports.** Panel: 443 inbound (Direct mode only). Agents: no inbound port. Minecraft servers: 25565/TCP (and any port you chose) in Direct mode.
