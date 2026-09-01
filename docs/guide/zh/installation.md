# 安装

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · **中文**

_本文档由社区译自英文版，如有出入以英文版为准；译文可能滞后，存疑时请查阅[英文版](../installation.md)。应用界面提供英语和法语两种语言。_

用户指南——先安装**面板**（panel，装在一台常开的机器上），再在每台托管 Minecraft 服务器的机器上安装**代理**（agent，两者常常是同一台机器）。一切都以自包含压缩包的形式分发：无需预先安装 Node、Java 或 Python。

打包支持的平台：**Windows x64**、**Linux x64**、**Linux ARM64**（Raspberry Pi 4/5、ARM 服务器）、**macOS Apple Silicon**。Windows ARM64 可通过 x64 压缩包运行（模拟）。Intel macOS 未提供打包。

**支持哪些 Linux 发行版？** 自 1.0.5 起，面板不再包含任何编译模块，因此**任何基于 glibc 的发行版都可以运行**：Ubuntu 20.04 及以上、Debian 11 及以上、Fedora、Rocky/Alma/RHEL 9、openSUSE、Raspberry Pi OS、Oracle Linux、Arch……无需安装任何东西，既不需要编译器，也不需要开发包。唯一的例外是 **Alpine** 等基于 musl 的系统，内置的 Node 运行时不支持它们：请改用官方 Docker 镜像（§1.2 —— 它自带 libc）、改用基于 glibc 的发行版，或用你自己的 Node ≥ 24 运行面板（在解压后的目录里执行 `node app/dist/main.js`）。

## 1. 面板

### 1.1 下载

打开 [releases 页面](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)，下载与你的机器相符的文件：

| 你的机器                                        | 要下载的文件                              |
| ----------------------------------------------- | ----------------------------------------- |
| Windows（任何较新的电脑）                       | `mmo-panel-<version>-win-x64.zip`         |
| 普通电脑或服务器上的 Linux                      | `mmo-panel-<version>-linux-x64.tar.gz`    |
| ARM 上的 Linux（树莓派、Oracle/Ampere 云主机…） | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| 使用 Apple Silicon 的 Mac（M1–M4）              | `mmo-panel-<version>-darwin-arm64.tar.gz` |

不确定自己用的是哪种 Linux？执行 `uname -m`：`x86_64` 表示 x64，`aarch64` 表示 ARM64。

压缩包是自包含的：它自带 Node 运行时、面板、网页界面，以及四个平台的代理安装脚本。**事先无需安装任何东西**——不需要 Node、不需要 Java、不需要编译器、不需要开发包。

> 想校验下载的文件？每个发行版本还会发布 `panel-<平台>.json`，其中包含预期的 SHA-256。用 `sha256sum <文件>`（Linux/macOS）或 `Get-FileHash <文件>`（Windows）比对即可。

### 1.2 解压并运行

**Linux，一条命令。** 在带 systemd 的机器上（Ubuntu、Debian、Fedora、Raspberry Pi OS……），一次复制粘贴就完成 §1.1 到 §1.4 描述的全部工作——下载、SHA-256 校验、代码放到 `/opt/mmo-panel`、数据放到 `/var/lib/mmo-panel`、设置放到 `/etc/mmo-panel/panel.env`、加固过的 systemd 服务，然后等待面板应答：

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

**再次运行同一条命令即可升级**：先备份数据库，如果新版本起不来就换回旧版本。`--uninstall` 卸载（`--purge` 连数据一起删除），`--help` 列出其余选项（离线安装 `--archive`、`--dir`、`--data-dir`……）。如果你更想看到每一步，下面的手动方式依然完全受支持——安装器和手动方式得到的结果完全一样。

**Docker。** 官方镜像（x64/ARM64 多架构，内置代理）适用于机器跑 Alpine/musl 的情况，或者你本来就把一切都放在容器里。只需下载 [docker-compose.yml](https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docker-compose.yml)，然后：

```bash
docker compose up -d
```

面板在 `http://127.0.0.1:3000` 应答。数据存放在**命名卷** `mmo-data` 中——请抵住使用 `./data` 绑定挂载的诱惑：它在第一次 `up` 时由 root 创建，会精确地重现「无法打开数据库」的权限错误，因为容器以用户 `node`（uid 1000）运行。在容器内部，面板监听所有网络接口（这是镜像的一个明确选择）：真正对外暴露与否由 `ports:` 这一行决定——保留 `127.0.0.1:3000:3000`，并在宿主机上使用 `tailscale serve`（§3），或者在清楚后果的前提下对外暴露。命令行：`docker compose exec panel /app/entrypoint.sh doctor`（`setup`、`restore` 同理）。

**Windows，一条命令。** 同样的思路，在 PowerShell 中执行（它会自行请求提权）——代码放在 `C:\Program Files\mmo-panel`，数据放在 `C:\ProgramData\mmo-panel`，并注册一个延迟自动启动的 Windows 服务：

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

再次运行即可升级（先备份，新版本起不来就回滚）。选项：`-Port`、`-Archive`（离线）、`-MigrateFrom C:\旧\panel`（复制此前手动安装的数据，用 `integrity_check` 校验，绝不改动原件）、`-ServiceAccount User`（备份目标是网络驱动器时）、`-Uninstall`（`-Purge` 连数据一起删除）。你的选择会被记住，下次升级直接沿用。

安装器还会在「开始」菜单放入 **MinecraftManagerOnline**：时钟旁边会出现一个小图标——左键点击打开界面，右键提供打开、日志、启动/停止/重启、「开机自动启动」和退出。该图标操作的是服务（它绝不会启动第二个面板）；如果安装时没有服务，它会自己启动面板，退出时把它关掉。

**Windows，手动方式。** 右键点击 `.zip` → **全部解压缩**，解压到一个你打算长期保留的目录，例如 `C:\mmo\panel`（不要放在「下载」或桌面）。打开该目录，双击 **`mmo-panel.cmd`**。会打开一个黑色窗口并保持开启：那就是正在运行的面板，关闭窗口即停止面板——§1.4 会把它变成真正的服务。在终端中：

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux。** 在终端里，进入下载文件所在的目录：

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

试用这样就够了。如果这台机器要长期运行，请把它放到固定位置——并注意 `chown`，这是最浪费时间的一个坑：

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # 以 root 解压 —— 把它交给实际启动它的用户（§1.4 把它交给服务账号 mmo）
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** —— 命令与 Linux 相同。首次启动时 macOS 可能拒绝运行下载来的二进制文件：系统设置 → 隐私与安全性 → 「仍要打开」。

> 出了问题？`mmo-panel.cmd doctor`（Windows）或 `./mmo-panel.sh doctor`（Linux/macOS）会检查运行时、数据目录及其属主、数据库和端口，并告诉你该怎么做——见 §1.6。

面板监听 `http://127.0.0.1:3000`（绝不监听所有接口——对外暴露由访问层负责，见 §3；`0.0.0.0` 在启动时会被拒绝）。常用变量：`MMO_PORT`、`MMO_HOST`（指定某个地址）、`MMO_DATA_DIR`（默认是脚本旁边的 `./data`——**这就是需要备份的目录**：SQLite 数据库、指标、证书、发行包）。除控制台外，面板还会把日志写入 `data/logs/panel-<date>.log`（保留 14 天）——窗口关闭之后出了问题，就到这里查看。

### 1.3 首次启动

打开 `http://127.0.0.1:3000`。在没有显示器的机器上（服务器、云主机）：要么先配置远程访问（§3 —— 安装 Tailscale，运行 `tailscale serve` 命令，然后从另一台设备打开 `https://<机器>.<tailnet>.ts.net`），要么使用 SSH 隧道（`ssh -L 3000:127.0.0.1:3000 用户@机器`，然后在本地打开 `http://127.0.0.1:3000`）。向导分两步——**Administrator account**（管理员账号：用户名、密码、语言），然后是 **Access**（访问）：**面板的公开 URL**（此阶段可选）、**访问模式**（见 §3）和**默认备份目标**。公开 URL 随时可以在 Settings → General 中修改：它会被注入代理安装命令和推送通知中——远程访问一旦就绪就把它填上。

**完全没有浏览器时**（云主机、容器、cloud-init），管理员账号改从命令行创建——`setup` 与向导走的是同一段代码。在一台通过 SSH 访问的全新云主机上（Oracle、AWS、Hetzner……），完整流程是这样的：

1. **安装** —— §1.2 的一条命令安装器会完成一切，服务也包括在内：

   ```bash
   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
   ```

2. **创建管理员账号。** 安装器以服务账号 `mmo` 运行面板，数据位于 `/var/lib/mmo-panel` —— 请以同一身份执行 `setup`：

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --random-password
   ```

   生成的密码只会显示一次——请立即复制。想自己指定密码，用 `--password-stdin`（`echo -n '密码' | … setup --username admin --password-stdin`）或 `--password-file <文件>`——切勿作为命令行参数传入，命令行对机器上的所有进程都是可见的。`--public-url`、`--locale` 和 `--access-mode` 是可选的。该命令拒绝执行第二次。若是手动安装（§1.2），数据就在脚本旁边且归你所有，则无需任何前缀：`/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.example.net`。

3. **检查。** `doctor`（§1.6）会检查整套安装，面板日志则通过 journalctl 输出：

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh doctor
   journalctl -u mmo-panel -f
   ```

4. **从你自己的电脑打开界面**（§3）。可以在云主机上安装 Tailscale，把面板发布到你的 tailnet：

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   然后打开 `https://<vm>.<tailnet>.ts.net` —— 或者，若只想快速看一眼而不安装任何东西，使用 SSH 隧道：`ssh -L 3000:127.0.0.1:3000 用户@vm`，然后在自己的电脑上打开 `http://127.0.0.1:3000`。

**使用 cloud-init 时**，同样的流程可以在云主机第一次启动时就跑完，甚至在你首次登录之前。请使用 `--password-file` 搭配由 `write_files` 写入的文件——不要用 `--random-password`，它那一次性的输出会淹没在 cloud-init 日志里。该文件可以放在 `/var/lib/mmo-panel` 内：安装器会把整个目录交给 `mmo` 账号，因此面板能在那里读到它。

```yaml
write_files:
  - path: /var/lib/mmo-panel/admin-password
    permissions: '0600'
    content: |
      在这里写一个足够长的密码
runcmd:
  - curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh -o /run/install-panel.sh
  - sh /run/install-panel.sh
  - sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --password-file /var/lib/mmo-panel/admin-password
  - rm -f /var/lib/mmo-panel/admin-password /run/install-panel.sh
```

有两点需要知道。Cloud-init 以 root 身份运行，且没有终端：任何命令都绝不能等待按键——`install-panel.sh` 从不这样做，这是它的规则之一。另外，`runcmd` 开始时网络未必已经就绪：如果下载失败，等云主机可访问后手动重跑同一条命令即可。

### 1.4 开机自启（服务）

> 用一条命令的安装器装好的（§1.2，Linux 或 Windows）？服务已经存在——本节针对手动安装。

**Windows**（压缩包内含 shawl）—— 在**管理员** PowerShell 中：

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

服务随后以 `LocalSystem` 身份运行；若要以你自己的账号运行（备份目标是网络驱动器时推荐这样做），可用 `services.msc` → 登录，或参照代理的做法（§2.2）。环境变量（`MMO_PORT`……）：`shawl add --env MMO_PORT=3000 …`。

> 重要：`mmo-panel.cmd` 会设置 `MMO_WEB_DIR` 和 `MMO_DIST_DIR`；使用 shawl 时必须显式加上：`--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`。

**Linux**（systemd）—— `/etc/systemd/system/mmo-panel.service`：

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

**macOS**（launchd）—— `/Library/LaunchDaemons/com.mmo.panel.plist`，其中 `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`，`RunAtLoad` 与 `KeepAlive` 设为 `true`，然后执行 `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`。

### 1.5 升级面板

有新版本时面板会主动告诉你：一旦发布新版本，管理员就会看到横幅提示（最多每 6 小时查询一次 GitHub 的 releases 订阅源—— Settings → General 可以关闭该检查，通知类别「New panel version published」会让铃铛响起）。

用一条命令的安装器装好的（§1.2，Linux 或 Windows）？再次运行同一条命令即可——它会备份数据库、替换代码、重启服务，并在新版本起不来时自动回滚。手动安装：停止服务，把新压缩包**覆盖解压**（压缩包里从来没有 `data/` 目录），再启动。数据库迁移在启动时执行。新压缩包内含同版本的代理：面板会自动发布代理版本；如果勾选了「Update agents automatically when they connect」（代理连接时自动更新，Settings → General——默认不勾选），每个代理都会在下次连接时更新，失败自动回滚。否则就在每台机器页面的 Agent 卡片里逐个更新。

### 1.6 面板起不来时：`doctor`

在阅读堆栈之前，先问问面板哪里出了问题。它会检查运行时、所加载的模块、数据目录（一次**真实**写入，
并把属主与当前用户作比较）、数据库、端口和前端。

```powershell
C:\mmo\panel\mmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

每一行都以 `ok`、`warn` 或 `ERROR` 开头，每个错误都会说明该怎么做——包括当压缩包是用 `sudo` 解压、
而面板以另一个用户运行时，需要执行的确切 `chown` 命令。只要有一项检查失败，该命令就以 1 退出，因此
可以放进脚本里使用。

### 1.7 备份与恢复面板

面板每天自动备份自己一次（对数据库做一致的 `VACUUM INTO` 复制），保存到 `data/backups/panel/mmo-<date>.db`，保留 7 份；Settings → Panel backups 可以随时手动创建一份。指标数据（`metrics.db`）不会被复制：它可以重建，而且体积很大。如果你想保留证书和代理压缩包，请把整个 `data/` 目录一并备份。

**恢复**方法：先停止面板（服务或 Ctrl+C），然后：

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

如果副本就放在 `data/backups/panel/` 里，只写文件名即可；完整路径同样接受。副本会被校验（`integrity_check`），当前数据库会以 `mmo.db.before-restore-<date>` 保留，之后即可重新启动面板：代理会用原有的密钥重新连接，它们承载的服务器会以相同的标识被重新接管（`.mmo-server.json` 标记文件）。备份之后创建的一切（用户、已配对的机器、设置）都会丢失：备份之后配对的机器需要重新配对。如果 `mmo.db-wal` 不为空，恢复会拒绝执行（面板仍在运行，或被强行终止——先启动它，再干净地停止，然后重试）。

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
- ⚠ **服务器目录的权限。** 作为系统服务安装时，代理以 `mmo` 身份运行，而不是以你的身份：放在 `/home/<你>/…` 下的服务器对它往往只读。服务器一被接管，面板就会提示（「folder not writable」），被拒绝的启动也会指明目录和账号。两种做法，任选其一：
  - 给代理的账号授予访问权限：`sudo chown -R mmo /我的/服务器目录`（或先 `sudo usermod -aG <你的组> mmo`，再 `sudo chmod -R g+w`）；
  - 或者以你自己的账号安装代理：`--user <你>`（系统服务）或 `--user-service`（无需 root）。
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
