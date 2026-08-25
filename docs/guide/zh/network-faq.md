# 网络常见问题

[English](../network-faq.md) · [Français](../fr/faq-reseau.md) · [Español](../es/network-faq.md) · [Deutsch](../de/network-faq.md) · [Português](../pt/network-faq.md) · [Русский](../ru/network-faq.md) · **中文**

_本文档译自英文版，如有出入以英文版为准。应用界面提供英语和法语两种语言。_

面板**只**监听 `127.0.0.1`（或通过 `MMO_HOST` 指定的某个具体地址）。从外部访问它有三种方式；选一种即可。

## Tailscale（默认，推荐）

**为什么**：在 CGNAT、4G、酒店 wifi 之后都能工作，无需开放任何端口；自动 HTTPS 证书；免费套餐最多 6 个用户（某些方案是 3 个——请自行确认）。

1. 在面板主机上安装 [Tailscale](https://tailscale.com/download) 并登录。
2. 在面板中，进入 Settings → Remote access（设置 → 远程访问），选 **Tailscale** 模式：复制并运行显示的命令，形如
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`。
   如果尚未开启，请在 Tailscale 控制台启用 **MagicDNS** 和 **HTTPS certificates**。
3. 公开 URL 变为 `https://<machine>.<tailnet>.ts.net`：把它填入 Settings → General。
4. 在每台客户端设备上（手机、朋友的 PC、远程的代理机器）：安装 Tailscale 并加入**同一个 tailnet**（邀请你的朋友，或共享节点）。
5. 运行 **Reachability test**（连通性测试；同一页面的 **Run the test**（运行测试）按钮）：HTTP、WebSocket、二进制帧和 TLS 证书（二进制帧会经过 `tailscale serve`）。

代理：安装命令使用 `https://…ts.net` URL；因此代理机器同样需要 Tailscale。Minecraft 服务器：使用 **Tailnet** 暴露方式，地址为 `100.x.y.z:25565`。

排障：在主机上运行 `tailscale status`；`tailscale serve status` 必须列出该转发（`No serve config` = serve 命令从未运行过——此时连通性测试会在 443 端口上报连接被拒绝）；如果 HTTP 通过而 WebSocket 测试失败，请检查前面是否还挡着另一个没配 `Upgrade` 的代理（nginx）。如果终端提示 `tailscale` 不是可识别的命令（Windows），说明 CLI 不在你的 PATH 中：请用**双**引号括起完整路径来调用（单引号在 Windows 上会出错）——命令提示符：`"C:\Program Files\Tailscale\tailscale.exe" serve …`，PowerShell：同样的写法并在前面加 `&`（按你的安装目录调整）。

## Direct（IPv6 + 自有域名）

**为什么**：没有中间人，朋友们什么都不用装。**前提**：一个公网 IPv6（大多数家用路由器都有）——CGNAT 之后的 IPv4 不行。

1. 一个域名：可用 **DuckDNS** 免费获得（`your-name.duckdns.org`），或用托管在 Cloudflare 上的域名；也可以在 **manual**（手动）模式下使用任何服务商（DNS 记录由你自己创建）。
2. Settings → Remote access，选 **Direct** 模式：填写域名、DNS 服务商、令牌（DuckDNS：网站上的 token；Cloudflare：具有 `Zone:DNS:Edit` 权限的 API token）、ACME 邮箱。先 **Save**（保存）再 **Request a certificate**（申请证书）：面板会创建 `_acme-challenge` TXT 记录（手动模式下则显示出来让你自己创建），等待传播，获取 Let's Encrypt 证书，并在你的全局 IPv6 地址的 443 端口上开启 HTTPS 监听。
3. **动态 DNS**：“Update the AAAA record automatically”（自动更新 AAAA 记录）开关——面板每 10 分钟更新一次 AAAA 记录（DuckDNS/Cloudflare/通用 URL）。手动模式下，请自行把 AAAA 记录指向所显示的 IPv6。
4. **路由器 / 防火墙**：在路由器上创建一条指向主机地址 443/TCP 的 IPv6 _pinhole_（Freebox：“Ouvrir un port IPv6”；Livebox：“Pare-feu IPv6”）。在主机上添加 Settings → Remote access → **Firewall rules**（防火墙规则）中显示的规则（PowerShell `New-NetFirewallRule` / `ufw allow`）。_临时_ IPv6 地址（隐私扩展）会随时间变化：面板会选用上一轮检测时看到的稳定地址；拿不准时，请在 “Public IPv6 address”（公网 IPv6 地址）中手动固定。
5. 公开 URL：`https://your-name.duckdns.org`（Settings → General），然后运行 **Reachability test**。

Minecraft 服务器：使用 **Direct** 暴露方式，每个游戏端口都要做 pinhole + 防火墙规则（在同一位置显示）。仅有 IPv4 的玩家将无法连接：对他们来说，优先考虑 Tailscale。

续期：自动进行，剩余有效期 < 30 天后每天检查一次——手动 DNS 除外（面板会提醒你：请再次申请证书）。

## Manual（已有反向代理）

把你的代理（Caddy、nginx、Traefik…）指向 `http://127.0.0.1:3000`，**启用 WebSocket 支持**（`Upgrade`/`Connection`）且帧大小至少 16 MB，并转发 `X-Forwarded-Proto` / `X-Forwarded-Host`。Caddy 示例：

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

填入公开 URL 并运行连通性测试：当这些标头被正确转发时，结果中的 “Seen via” 一行会显示 “a reverse-proxy”。

## 常见问题

**安装后代理一直是 `offline`。** 在该机器上查看日志——Windows：`%LOCALAPPDATA%\Programs\mmo-agent` 根目录下的 `launcher.log`，以及其 `logs\` 子文件夹中的服务日志；Linux：`journalctl -u mmo-agent -f`（如果用 `--user-service` 安装则加 `--user`）；macOS：`/var/lib/mmo-agent/agent.log`。常见原因：从该机器无法访问面板 URL（Tailscale 未安装/未连接、防火墙）、证书不受信任（手动模式 + 私有 CA：把它加入系统证书库）、配对码过期（安装时会显示 `pairing failed` 消息），或代理残留了另一个面板的状态（日志中出现 `unknown, unpaired or disabled agent`——安装程序会自动重新配对；实在不行就用 `-Purge` / `--purge` 卸载后再运行一次安装命令）。

**面板可以访问但 WebSocket 失败。** 代理没配 `Upgrade`，或空闲超时太短。连通性测试会指出失败在哪一步（HTTP、WebSocket、Binary frames、TLS certificate）。

**推送通知一直收不到。** 它需要 HTTPS（Tailscale 或 Direct），并且在 iOS 上还需要把 PWA 安装到主屏幕（Account → Push notifications 会一步步引导你；另见[安装 § 4](installation.md#4-在手机上安装-pwa)）。同一位置的 “Send a test” 按钮可以检验整条链路。

**代理停止或更新时服务器也跟着挂了。** 这不应该发生：服务器以分离方式运行，服务被配置为只结束代理本身（`KillMode=process`、`AbandonProcessGroup`、shawl）。如果你手工安装过服务，请检查该设置；绝不要对代理使用 `taskkill /T`。

**只有 IPv4（路由器没有 IPv6）。** 没有公网 IPv4 端口映射就无法使用 Direct 模式；请使用 Tailscale。

**端口。** 面板：443 入站（仅 Direct 模式）。代理：无入站端口。Minecraft 服务器：Direct 模式下 25565/TCP（以及你选择的任何端口）。
