# 安装

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · **中文**

_本文档译自英文版，如有出入以英文版为准。应用界面提供英语和法语两种语言。_

用户指南——先安装**面板**（panel，装在一台常开的机器上），再在每台托管 Minecraft 服务器的机器上安装**代理**（agent，两者常常是同一台机器）。一切都以自包含压缩包的形式分发：无需预先安装 Node、Java 或 Python。

打包支持的平台：**Windows x64**、**Linux x64**、**Linux ARM64**（Raspberry Pi 4/5、ARM 服务器）、**macOS Apple Silicon**。Windows ARM64 可通过 x64 压缩包运行（模拟）。Intel macOS 未提供打包。

## 1. 面板

### 1.1 下载

从 [GitHub releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases) 获取 `mmo-panel-<version>-<platform>.zip`（Windows）或 `.tar.gz`（Linux / macOS）压缩包。其中包含固定版本的 Node 运行时、面板、Web 界面，以及全部 4 个平台的代理安装压缩包（`dist-agent/`）。

> 没有适合你平台的压缩包？两条命令即可从源码构建：见 [README](../../../README.zh.md) 中的“快速上手”。

### 1.2 解压并启动

**Windows** — 解压到一个固定的文件夹，例如 `C:\mmo\panel`，然后：

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux / macOS**：

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
/opt/mmo/mmo-panel/mmo-panel.sh
```

面板监听 `http://127.0.0.1:3000`（绝不监听所有网卡——对外暴露由访问层负责，见 §3；启动时会直接拒绝 `0.0.0.0`）。有用的环境变量：`MMO_PORT`、`MMO_HOST`（某个具体地址）、`MMO_DATA_DIR`（默认为脚本旁边的 `./data` — **这就是需要备份的文件夹**：SQLite 数据库、指标、证书、发布版本）。除控制台输出外，面板还会把日志写入 `data/logs/panel-<date>.log`（保留 14 天）——窗口关闭后如果出了问题，就到这里查看。

### 1.3 首次启动

打开 `http://127.0.0.1:3000`：向导分两步——**Administrator account**（管理员账户：用户名、密码、语言），然后 **Access**（访问）：**面板公开 URL**（此阶段可留空）、**访问模式**（见 §3）和**默认备份目标位置**。公开 URL 随时可以在 Settings → General（设置 → 常规）中修改：它会被注入到代理安装命令和推送通知中——远程访问一旦就绪就尽快设置好。

### 1.4 开机自启（服务）

**Windows**（压缩包内附带 shawl）— 在**管理员** PowerShell 中：

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

之后服务以 `LocalSystem` 身份运行；若要让它在你自己的账户下运行（当备份目标是网络驱动器时推荐这样做），请使用 `services.msc` → Log On，或参照代理的做法（§2.2）。环境变量（`MMO_PORT`…）：`shawl add --env MMO_PORT=3000 …`。

> 重要：`mmo-panel.cmd` 会设置 `MMO_WEB_DIR` 和 `MMO_DIST_DIR`；使用 shawl 时需要显式添加：`--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`。

**Linux**（systemd）— `/etc/systemd/system/mmo-panel.service`：

```ini
[Unit]
Description=MinecraftManagerOnline panel
After=network-online.target
Wants=network-online.target

[Service]
User=mmo
WorkingDirectory=/opt/mmo/mmo-panel
ExecStart=/opt/mmo/mmo-panel/mmo-panel.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home-dir /opt/mmo/mmo-panel --shell /usr/sbin/nologin mmo
sudo chown -R mmo /opt/mmo/mmo-panel
sudo systemctl daemon-reload && sudo systemctl enable --now mmo-panel
```

**macOS**（launchd）— `/Library/LaunchDaemons/com.mmo.panel.plist`，其中 `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`，`RunAtLoad` 和 `KeepAlive` 设为 `true`，然后 `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`。

### 1.5 更新面板

停止服务，把新压缩包**覆盖**解压到原处（`data/` 文件夹从不包含在压缩包内），然后重启。数据库迁移在启动时自动执行。新压缩包内置同版本的代理：面板会自动发布代理版本，如果勾选了 “Update agents automatically when they connect”（代理连接时自动更新，位于 Settings → General——默认不勾选），每个代理会在下次连接时更新，失败时自动回滚。否则，就在每台机器页面的 Agent 卡片中逐台更新。

### 1.6 备份与还原面板

面板每天自动备份一次自身（用 `VACUUM INTO` 生成数据库的一致性副本）到 `data/backups/panel/mmo-<date>.db`，保留 7 份；Settings → Panel backups（面板备份）可随时手动创建一份。指标数据（`metrics.db`）不会被复制：它可以重建且体积很大。如果还想保留证书和代理压缩包，请把整个 `data/` 文件夹也一并备份。

要**还原**：先停止面板（服务或 Ctrl+C），然后：

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

对于位于 `data/backups/panel/` 中的副本，只写文件名即可；也接受完整路径。副本会先经过校验（`integrity_check`），当前数据库会保留为 `mmo.db.before-restore-<date>`，随后即可重启面板：代理会用原有密钥重新连接，其托管的服务器会以相同的标识符被重新接管（`.mmo-server.json` 标记文件）。备份之后创建的一切（用户、已配对的机器、设置）都会丢失：备份之后配对的机器需要重新配对。如果 `mmo.db-wal` 非空（面板仍在运行，或被强行终止——先把它启动再干净地停止，然后重试），还原会拒绝执行。

## 2. 代理

每台托管服务器的机器一个代理。它**主动向外**连接面板（WebSocket）：代理机器上无需开放任何端口。

### 2.1 一行命令

在面板中：**Machines → Add a machine**（机器 → 添加机器）。面板会生成一个配对码（15 分钟内有效）以及要在目标机器上粘贴的完整命令：

- **Windows**（PowerShell，任意版本）：
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS**：
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

脚本会从面板下载对应平台的压缩包，校验其 SHA-256 哈希，安装文件，为代理**配对**（配对码已过期时会立即报错），然后注册并启动服务。几秒钟内机器就会在面板中显示为 `online`。

> 目标机器必须能访问到面板（§3）。在设置公开 URL 之前，命令使用的是你打开面板时所用的地址。

### 2.2 脚本做了什么 — Windows

- 文件位于 `%LOCALAPPDATA%\Programs\mmo-agent`（运行时、`launcher.cjs`、`versions/<v>/agent.js`、`shawl.exe`），状态位于 `%LOCALAPPDATA%\mmo-agent`。
- `mmo-agent` 服务通过 **shawl** 注册，自动启动；它**以你的 Windows 账户运行**（密码只询问一次，在弹出的提权窗口中输入），这样代理才能看到你映射的网络驱动器和文件夹。准确地说：是提权窗口所用的账户——如果 UAC 让你输入的是另一位管理员的凭据，服务就会以那个账户运行。“Log on as a service”（作为服务登录）权限会自动授予（如果失败，脚本会继续执行并说明如何用 `secpol.msc` 手动授予）。替代方案：`-ServiceAccount LocalSystem`。
- **无密码账户**（用 PIN 登录或完全没有密码的会话）：Windows 禁止服务用空密码登录。在密码提示处直接回车确认留空：脚本会予以说明，并把服务注册为 `LocalSystem`（此时代理看不到你映射的网络驱动器）。想换回你的账户：给 Windows 设置一个密码，再运行一次该命令。
- 如果提权窗口中出现失败，消息会停留在屏幕上（回车关闭），详情在 `%TEMP%\mmo-install.log` 中。
- 服务崩溃后会自动重启；干净停止 = 向代理转发 Ctrl+C，**绝不**结束整个进程树：Minecraft 服务器在代理停止或更新期间继续存活，之后被重新接管。
- 选项：`-NoService`（仅安装文件）、`-InstallDir`、`-StateDir`、`-Panel`、`-Archive <zip>`（离线安装）。
- 卸载：`& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall`（加 `-Purge` 可同时删除状态；Minecraft 服务器绝不会被触碰）。

### 2.3 脚本做了什么 — Linux

- 文件位于 `/opt/mmo-agent`，状态位于 `/var/lib/mmo-agent`，如有需要会创建系统账户 `mmo`（`--user <name>` 可指定其他账户——代理必须能读写服务器文件夹）。
- `mmo-agent` systemd 单元使用 `KillMode=process`（分离运行的服务器得以存活）和 `Restart=on-failure`。需要时会请求 `sudo`。
- **无 root 权限**：`--user-service` 安装到 `~/.local/share/mmo-agent`（文件在 `app/`，状态在根部），使用 `systemctl --user` 和 `loginctl enable-linger`（无需保持会话打开即可开机启动）。注意：通过 `sudo` 运行时，`--user-service` 会被忽略并执行系统级安装。
- 选项：`--no-service`、`--dir`、`--state-dir`、`--panel`、`--archive <tar.gz>`（离线安装）。
- 卸载：`curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]`（如果当初用 `--user-service` 安装，请加上它）。系统账户 `mmo` 会被保留（不再需要时可 `userdel mmo`）。
- 在 **WSL** 下，最后一个终端关闭几秒后虚拟机就会停止：服务（以及服务器）随之停止——WSL 适合试用，不适合托管。

### 2.4 脚本做了什么 — macOS

逻辑相同：`/opt/mmo-agent`、`com.mmo.agent` LaunchDaemon（`KeepAlive`、`AbandonProcessGroup`：服务器得以存活），账户 = 运行 `sudo` 的用户。`--user-service` 则改为创建 LaunchAgent（仅在会话登录时启动）。日志：`/var/lib/mmo-agent/agent.log`。

### 2.5 机器重启之后

服务会重新拉起代理；代理重新接管仍然存活的服务器（PID + 启动时间 + 命令行），并且如果启用了 “Restore desired state when an agent boots”（代理启动时恢复期望状态，位于 Settings → General），会重启那些标记为 `running` 的服务器。

### 2.6 离线安装

从面板（Settings → Agent distribution，代理分发）或 release 下载对应平台的压缩包，连同脚本一起复制过去（`install.ps1` / `install.sh` 也在压缩包里），然后运行 `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` 或 `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …`（SHA-256 哈希只对从面板下载的压缩包进行校验——本地压缩包原样使用）。

## 3. 远程访问（摘要）

面板只监听 `127.0.0.1`。要让其他机器上的代理、你的朋友和你的手机访问到它，请选择一种模式（Settings → Remote access，远程访问）：

| 模式                  | 适合谁                                           | 要做什么                                                                              |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Tailscale**（默认） | 所有人，包括 CGNAT/4G 之后                       | 在面板主机和每台客户端设备上安装 Tailscale，然后运行面板显示的 `tailscale serve` 命令 |
| **Direct**            | 你有公网 IPv6 和一个域名（DuckDNS、Cloudflare…） | 填写域名 + DNS 服务商，申请证书（DNS-01），开放 443 端口（在路由器上做 IPv6 pinhole） |
| **Manual**            | 你已经在运行反向代理                             | 把它指向 `127.0.0.1:3000` 并启用 WebSocket 支持                                       |

无论哪种情况，**Reachability test**（连通性测试）卡片（**Run the test**（运行测试）按钮，位于 Settings → Remote access）都会通过公开 URL 检查 HTTP、WebSocket、二进制帧（64 KiB）和 TLS 证书。详情与排障：[网络常见问题](network-faq.md)。添加机器以及要发给玩家的地址：[添加机器](add-a-machine.md)。

## 4. 在手机上安装 PWA

面板是一个可安装的 Web 应用（PWA）：远程访问配置好之后（§3——安装需要 HTTPS），在手机浏览器中打开公开 URL，并把应用添加到主屏幕：

- **Android（Chrome）**：⋮ 菜单 → “Add to Home screen”（添加到主屏幕；有时会直接显示 “Install app”）。
- **iOS（Safari）**：分享按钮 → “Add to Home Screen”（添加到主屏幕）。在 iOS 上，这一步是接收推送通知的**必要条件**：通知只在已安装的 PWA 中有效，Safari 里收不到。

之后应用会全屏打开，导航栏位于屏幕底部。要接收通知（服务器崩溃、备份失败、代理离线…）：Account（账户）页面 → Push notifications（推送通知）——启用后选择类别，并用 “Send a test”（发送测试）按钮验证。在 Tailscale 模式下，手机必须安装 Tailscale 应用并连接到 tailnet 才能访问面板。
