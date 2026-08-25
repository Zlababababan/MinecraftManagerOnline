# 添加机器

[English](../add-a-machine.md) · [Français](../fr/ajouter-une-machine.md) · [Español](../es/add-a-machine.md) · [Deutsch](../de/add-a-machine.md) · [Português](../pt/add-a-machine.md) · [Русский](../ru/add-a-machine.md) · **中文**

_本文档译自英文版，如有出入以英文版为准。应用界面提供英语和法语两种语言。_

**机器**（machine）= 一台托管 Minecraft 服务器、由代理驱动的电脑。面板主机本身也可以是其中之一（最常见的情况：一切都跑在游戏 PC 上）。

## 1. 创建机器并获取命令

1. 面板 → **Machines**（机器）→ **Add a machine**（添加机器），给它起个名字。
2. 面板会显示一个**配对码**（`MMOP-XXXX-XXXX`，15 分钟内有效，一次性使用）以及 Windows 和 Linux/macOS 的完整命令。
3. 在目标机器上粘贴该命令——它具体做了什么详见[安装 § 2](installation.md#2-代理)。
4. 机器在面板中变为 `online`。如果配对码已过期，**New pairing code**（新配对码）会生成一个新的（该机器之前的配对码全部失效）；再运行一次命令即可。

命令中包含面板的公开 URL：如果目标机器和你不在同一网络，请先核对一遍（Settings → General）。

## 2. 检测服务器

在机器页面：**Watched directories**（受监视目录）→ 添加你的服务器所在的上级文件夹（例如 `E:\Minecraft\Server`、`/srv/minecraft`）。代理会进行扫描（Forge、NeoForge、Fabric、Vanilla；1.12 → 1.21+），并**自动接管**每个检测到的服务器，连同其 loader、版本和内存——周期性扫描自动运行，**Scan now**（立即扫描）可强制立刻执行一轮，**Add a server folder**（添加服务器文件夹）则无需等待即可登记某个特定文件夹。此后一切仍可在服务器页面上修改（手工调整过的整合包有时会骗过启发式检测——每个检测值的来源都会显示出来）。接管时不会修改磁盘上的任何内容，唯一的例外是启用 RCON（`server.properties`，自动生成密码），这是在分离模式下控制服务器所必需的。

Java：代理会清点机器上已有的 JRE；如果缺少所需版本，可从机器页面的 **Java runtimes**（Java 运行时）卡片安装（**Install this runtime**（安装此运行时）按钮——Temurin，否则 Zulu，自动下载并校验）。

## 3. 首次启动服务器

从服务器卡片（仪表盘）或其页面启动服务器，观察状态从 `starting` 变为 `running`（显示 PID）。**Console**（控制台）标签页实时显示日志行并接受命令。全新服务器首次启动时，如果尚未接受 Mojang EULA，面板会一步步引导你完成（说明、链接、勾选框），然后再次启动即可。其余功能都在服务器页面的各个标签页中：**Players**（玩家：whitelist、op、封禁——完全不用打开文件）、**Configuration**（配置：逐项解释的 `server.properties`）、**Files**（文件）、**Backups**（备份）、**Metrics**（指标）、**Scheduler**（计划任务）、**Logs**（日志）。

## 4. 给玩家的地址

每个服务器都有一个 **Exposure**（暴露方式）设置（**Player access**（玩家访问）卡片，位于服务器页面的 Overview（概览）标签页）：

- **Tailnet**：你的朋友安装 Tailscale 并加入你的 tailnet（节点共享或邀请）；要给他们的地址是该机器的 `100.x.y.z` IP（或 MagicDNS 名称）+ 端口。
- **Direct**：公网地址——如果该机器就是处于直连模式的面板主机，用你的域名；否则用机器的全局 IPv6（或你在机器页面 “Addresses for players”（给玩家的地址）卡片中填写的公网主机名）。开放服务器的端口（路由器上的 IPv6 pinhole + Settings → Remote access → Firewall rules 中显示的规则）。

同一局域网内的玩家什么都不用做：无论哪种模式，局域网地址 + 端口即可。卡片上的 **Test reachability**（测试连通性）按钮会从面板主机执行一次真实的 _Server List Ping_（版本、玩家、MOTD）：这正是 Minecraft 客户端将看到的内容。

## 5. 多台机器

- 服务器可以在机器之间**迁移**（Overview 标签页的 **Migration**（迁移）卡片 → **Migrate to another machine**（迁移到另一台机器））：先对目标进行预检（磁盘空间、Java、端口），代理间直接传输或经面板中转，完成切换，旧文件夹被重命名为 `.migrated-<date>`。
- **备份**支持按服务器设置目标位置（本地，或共享/挂载的文件夹）、基于策略的轮换、一键还原。
- 代理更新：Settings → General → “Update agents automatically when they connect”，或在机器页面（Agent 卡片）手动更新。更新后 30 秒内未恢复健康的代理会自行回滚到上一版本。

## 6. 移除机器

机器页面 → **Remove machine**（移除机器）：它从面板中消失（磁盘上的服务器和文件保持原封不动）。在机器本身上：`install.ps1 -Uninstall` / `install.sh --uninstall`（[安装 § 2](installation.md#2-代理)）。
