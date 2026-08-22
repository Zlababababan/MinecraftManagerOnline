/** `server.properties` explained key by key — English (reference). Keys: `.` → `_`. */
export const propertiesEn = {
  motd: {
    label: 'Server description (MOTD)',
    help: 'Text shown in the multiplayer server list. Supports § colour codes and \\n line breaks.',
  },
  gamemode: {
    label: 'Default game mode',
    help: 'Mode given to new players: survival, creative, adventure or spectator.',
  },
  'force-gamemode': {
    label: 'Force game mode',
    help: 'Players are switched back to the default game mode every time they join.',
  },
  difficulty: {
    label: 'Difficulty',
    help: 'Peaceful removes hostile mobs; hard makes hunger and damage harsher.',
  },
  hardcore: {
    label: 'Hardcore',
    help: 'Difficulty locked to hard and players are put in spectator mode on death.',
  },
  pvp: { label: 'Player versus player', help: 'Allow players to damage each other.' },
  'allow-flight': {
    label: 'Allow flight',
    help: 'Tolerate players flying in survival (mods, elytra glitches). Off = kicked for flying.',
  },
  'enable-command-block': {
    label: 'Command blocks',
    help: 'Allow command blocks to run commands.',
  },
  'max-players': { label: 'Maximum players', help: 'How many players can be online at once.' },
  'online-mode': {
    label: 'Online mode (Mojang authentication)',
    help: 'Verify accounts with Mojang. Turn off only for LAN or proxies — players can then impersonate anyone.',
  },
  'white-list': {
    label: 'Whitelist enabled',
    help: 'Only players on the whitelist can join. Applied immediately while the server is running.',
  },
  'enforce-whitelist': {
    label: 'Enforce whitelist',
    help: 'Kick online players who are removed from the whitelist.',
  },
  'player-idle-timeout': {
    label: 'Idle timeout (minutes)',
    help: 'Kick players idle for longer than this. 0 disables.',
  },
  'op-permission-level': {
    label: 'Operator permission level',
    help: '1 = bypass spawn protection, 2 = cheats, 3 = player management, 4 = full (stop, etc.).',
  },
  'function-permission-level': {
    label: 'Function permission level',
    help: 'Permission level used by functions from data packs.',
  },
  'hide-online-players': {
    label: 'Hide online players',
    help: 'Do not list player names in the server status.',
  },
  'enforce-secure-profile': {
    label: 'Secure chat profiles',
    help: 'Require signed chat (Mojang key). Off lets older clients and some mods connect.',
  },
  'spawn-protection': {
    label: 'Spawn protection radius',
    help: 'Blocks around spawn that only operators can edit. 0 disables.',
  },
  'level-name': {
    label: 'World folder',
    help: 'Name of the world folder. Changing it loads or creates another world.',
  },
  'level-seed': { label: 'World seed', help: 'Used only when generating a new world.' },
  'level-type': {
    label: 'World type',
    help: 'Normal, flat, large biomes, amplified or single biome.',
  },
  'generate-structures': {
    label: 'Generate structures',
    help: 'Villages, temples, strongholds… in newly generated chunks.',
  },
  'generator-settings': {
    label: 'Generator settings (JSON)',
    help: 'Custom settings for flat or custom world types.',
  },
  'allow-nether': { label: 'Allow the Nether', help: 'Enable nether portals.' },
  'spawn-monsters': {
    label: 'Spawn monsters',
    help: 'Hostile mobs spawn at night and in the dark.',
  },
  'spawn-animals': { label: 'Spawn animals', help: 'Passive animals spawn naturally.' },
  'spawn-npcs': { label: 'Spawn villagers', help: 'Villagers appear in villages.' },
  'max-world-size': {
    label: 'Maximum world size',
    help: 'World border radius in blocks (max 29 999 984).',
  },
  'max-build-height': {
    label: 'Maximum build height',
    help: 'Legacy setting for old versions; ignored since 1.18.',
  },
  'server-ip': {
    label: 'Bind address',
    help: 'Leave empty to listen on every interface. Only set it if the machine has several IPs.',
  },
  'server-port': {
    label: 'Game port',
    help: 'TCP port players connect to (default 25565). Must be free on the machine.',
  },
  'enable-status': {
    label: 'Show status',
    help: 'Answer server-list pings. Off makes the server appear offline in the list.',
  },
  'enable-query': {
    label: 'GameSpy query',
    help: 'Expose the UDP query protocol used by some monitoring tools.',
  },
  query_port: { label: 'Query port', help: 'UDP port for the query protocol.' },
  'network-compression-threshold': {
    label: 'Compression threshold',
    help: 'Packets bigger than this (bytes) are compressed. -1 disables, 0 compresses everything.',
  },
  'prevent-proxy-connections': {
    label: 'Block proxy connections',
    help: 'Refuse players whose IP differs from the one Mojang authenticated.',
  },
  'use-native-transport': {
    label: 'Native transport (Linux)',
    help: 'Use epoll for better network performance on Linux.',
  },
  'rate-limit': {
    label: 'Packet rate limit',
    help: 'Maximum packets per second per player before a kick. 0 disables.',
  },
  'accepts-transfers': {
    label: 'Accept transfers',
    help: 'Allow players to be transferred here from another server (1.20.5+).',
  },
  'view-distance': {
    label: 'View distance (chunks)',
    help: 'Chunks sent around each player. Big values cost RAM and bandwidth.',
  },
  'simulation-distance': {
    label: 'Simulation distance (chunks)',
    help: 'Chunks where entities and crops are ticked. Lower it first when TPS drop.',
  },
  'max-tick-time': {
    label: 'Watchdog timeout (ms)',
    help: 'The server kills itself if a tick takes longer. -1 disables (MMO has its own watchdog).',
  },
  'entity-broadcast-range-percentage': {
    label: 'Entity broadcast range (%)',
    help: 'How far entities are sent to clients, relative to the default.',
  },
  'sync-chunk-writes': {
    label: 'Synchronous chunk writes',
    help: 'Safer saves; turning it off speeds up saving at the cost of robustness.',
  },
  'max-chained-neighbor-updates': {
    label: 'Max chained neighbour updates',
    help: 'Limits cascading block updates. -1 removes the limit.',
  },
  'region-file-compression': {
    label: 'Region file compression',
    help: 'Compression of world files (1.20.5+). lz4 is faster, deflate is smaller.',
  },
  'pause-when-empty-seconds': {
    label: 'Pause when empty (seconds)',
    help: 'Stop ticking the world after this many seconds without players (1.21.2+). -1 disables.',
  },
  'enable-rcon': {
    label: 'RCON enabled',
    help: 'Managed by MMO: the agent enables RCON to control the server in detached mode.',
  },
  rcon_port: { label: 'RCON port', help: 'Managed by MMO (auto-provisioned free port).' },
  rcon_password: { label: 'RCON password', help: 'Managed by MMO (strong random password).' },
  'broadcast-rcon-to-ops': {
    label: 'Broadcast RCON to ops',
    help: 'Operators see the output of RCON commands in chat.',
  },
  'resource-pack': {
    label: 'Resource pack URL',
    help: 'Direct download link of a resource pack proposed to players.',
  },
  'resource-pack-sha1': {
    label: 'Resource pack SHA-1',
    help: 'Hash of the pack, lets clients cache it.',
  },
  'resource-pack-prompt': {
    label: 'Resource pack prompt',
    help: 'Message shown when the pack is proposed (JSON text).',
  },
  'require-resource-pack': {
    label: 'Require resource pack',
    help: 'Players refusing the pack are disconnected.',
  },
  'broadcast-console-to-ops': {
    label: 'Broadcast console to ops',
    help: 'Operators see console command output in chat.',
  },
  'enable-jmx-monitoring': {
    label: 'JMX monitoring',
    help: 'Expose tick times through JMX (Java tooling).',
  },
  'log-ips': { label: 'Log player IPs', help: 'Write player IP addresses in the logs.' },
  'text-filtering-config': {
    label: 'Text filtering config',
    help: 'Chat filtering configuration (advanced, usually empty).',
  },
  'initial-enabled-packs': {
    label: 'Initially enabled data packs',
    help: 'Data packs enabled when creating the world (comma-separated).',
  },
  'initial-disabled-packs': {
    label: 'Initially disabled data packs',
    help: 'Data packs disabled when creating the world.',
  },
  'bug-report-link': {
    label: 'Bug report link',
    help: 'URL shown to players to report problems (1.21.6+).',
  },
} as const;
