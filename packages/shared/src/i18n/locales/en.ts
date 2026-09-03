/**
 * Ressources i18n — anglais (langue de référence : sa forme définit les clés obligatoires du français).
 * Règle : aucun texte visible en dur ailleurs ; les erreurs protocole sont des codes traduits ici.
 */
export const en = {
  common: {
    appName: 'MinecraftManagerOnline',
    loader: {
      vanilla: 'Vanilla',
      forge: 'Forge',
      neoforge: 'NeoForge',
      fabric: 'Fabric',
      velocity: 'Velocity (proxy)',
      unknown: 'Unknown (to configure)',
    },
    confidence: {
      high: 'High confidence',
      medium: 'Medium confidence',
      low: 'Low confidence — please check',
    },
    runState: {
      stopped: 'Stopped',
      starting: 'Starting',
      running: 'Running',
      stopping: 'Stopping',
      crashed: 'Crashed',
      unreachable: 'Unreachable',
    },
    attachMode: {
      attached: 'Attached (console)',
      detached: 'Detached (RCON only until next restart)',
    },
    cpuSource: {
      cycles: 'CPU (cycle-accurate)',
      proc: 'CPU (/proc)',
      ticks: 'CPU (tick-based, may be underestimated)',
    },
    yes: 'Yes',
    no: 'No',
    unknown: 'Unknown',
    /** Phase 10 : textes des notifications push (localisés par le panel selon le destinataire). */
    notify: {
      serverCrashed: { title: '{{server}} crashed', body: 'The server crashed on {{machine}}.' },
      serverStartFailed: {
        title: '{{server}} failed to start',
        body: 'Start failed on {{machine}}: {{reason}}',
      },
      watchdogAlert: { title: 'Watchdog: {{server}}', body: '{{kind}} → {{action}} ({{machine}})' },
      agentOffline: {
        title: '{{machine}} is offline',
        body: 'The agent lost its connection to the panel.',
      },
      taskFailed: { title: 'Task failed: {{kind}}', body: '{{server}} · {{reason}}' },
      backupFailed: { title: 'Backup failed: {{server}}', body: '{{reason}}' },
      migrationDone: { title: 'Migration done: {{server}}', body: 'Now hosted on {{machine}}.' },
      migrationFailed: { title: 'Migration failed: {{server}}', body: '{{reason}}' },
      duplicationDone: { title: 'Copy done: {{server}}', body: 'New server ready on {{machine}}.' },
      duplicationFailed: { title: 'Copy failed: {{server}}', body: '{{reason}}' },
      agentUpdateApplied: {
        title: 'Agent updated: {{machine}}',
        body: 'Version {{version}} is running.',
      },
      agentUpdateRolledBack: {
        title: 'Agent update rolled back: {{machine}}',
        body: 'Back to {{version}}: {{reason}}',
      },
      panelUpdateAvailable: {
        title: 'Panel update available',
        body: 'Version {{version}} is published — you are running {{current}}.',
      },
      scheduleFailed: { title: 'Scheduled task failed', body: '{{server}} · {{action}}' },
      portConflict: {
        title: 'Port conflict on {{machine}}',
        body: 'Port {{port}} is already in use.',
      },
      alertMachineOffline: {
        title: '{{machine}} is offline',
        body: 'No sign of the agent for a while.',
      },
      alertServerDown: { title: '{{server}} is down', body: 'It is supposed to be running.' },
      alertDiskLow: {
        title: 'Disk almost full on {{machine}}',
        body: '{{percent}}% used, {{freeGb}} GB left.',
      },
      alertTpsLow: { title: '{{server}} is lagging', body: 'TPS down to {{tps}}.' },
      alertResolved: { title: 'Back to normal: {{scope}}', body: 'The alert has cleared.' },
      backupOverdue: {
        title: 'No backup for {{server}}',
        body: 'A scheduled backup has not run when expected.',
      },
      backupCorrupted: {
        title: 'Corrupted backup: {{server}}',
        body: 'An archive no longer matches its manifest — do not rely on it: {{path}}',
      },
      panelBackupFailed: {
        title: 'Panel backup failed',
        body: 'The daily copy of the panel database could not be written: {{reason}}',
      },
      webhookFailed: {
        title: 'Webhook "{{webhook}}" is failing',
        body: 'Deliveries no longer go through: {{reason}}. Settings → Webhooks.',
      },
      webhookRecovered: {
        title: 'Webhook "{{webhook}}" recovered',
        body: 'Deliveries go through again.',
      },
      webhookTest: {
        title: 'Webhook "{{webhook}}" test',
        body: 'This message comes from MinecraftManagerOnline: the webhook is set up correctly.',
      },
      replicaDone: {
        title: 'Off-site copy done: {{server}}',
        body: 'Archive copied to {{machine}}.',
      },
      replicaFailed: { title: 'Off-site copy failed: {{server}}', body: '{{reason}}' },
      serverRunning: { title: '{{server}} is running', body: 'Started on {{machine}}.' },
      serverStopped: { title: '{{server}} stopped', body: 'Stopped on {{machine}}.' },
      playerJoined: { title: '{{player}} joined {{server}}', body: '{{online}} player(s) online.' },
      playerLeft: { title: '{{player}} left {{server}}', body: '{{online}} player(s) online.' },
      taskDone: { title: 'Task finished: {{kind}}', body: '{{server}}{{machine}}' },
      backupDone: { title: 'Backup done: {{server}}', body: 'Saved on {{machine}}.' },
      scheduleDone: { title: 'Scheduled task ran', body: '{{server}} · {{action}}' },
      agentProblem: { title: 'Problem on {{machine}}', body: '{{reason}}' },
      machinePaired: { title: 'New machine: {{machine}}', body: 'Paired from {{hostname}}.' },
      serverDiscovered: {
        title: 'New server found: {{server}}',
        body: 'On {{machine}} · {{path}}',
      },
      serverGone: { title: '{{server}} has disappeared', body: 'Folder no longer found: {{path}}' },
      serverDeleted: { title: '{{server}} deleted', body: 'Removed from the panel.' },
      serverMoved: { title: '{{server}} moved', body: 'Now at {{path}} on {{machine}}.' },
      serverConflict: { title: 'Conflict on {{machine}}', body: 'Two servers claim {{path}}.' },
      playerAction: { title: '{{action}} · {{target}}', body: 'On {{server}}.' },
      test: { title: 'Test notification', body: 'Push notifications work on this device.' },
    },
  },
  errors: {
    E_AUTH: 'Authentication failed.',
    E_PAIRING_CODE_INVALID: 'Invalid or expired pairing code.',
    E_UNSUPPORTED_VERSION: 'The agent protocol version is not supported — update the agent.',
    E_UNSUPPORTED_TYPE: 'This operation is not supported by the agent (requires a newer agent).',
    E_INVALID_PAYLOAD: 'Invalid request payload.',
    E_NOT_FOUND: 'Resource not found.',
    E_NOT_FOUND_PATHS_NOT_IN_ARCHIVE: 'Not in this archive: {{list}}. Nothing was changed.',
    E_INVALID_PAYLOAD_RESERVED_PATH:
      'This path is managed by the agent and is never restored: {{path}}.',
    E_IO_ARCHIVE_UNREADABLE:
      'The archive cannot be read (corrupted or truncated): do not restore from it — delete it and take a new backup.',
    E_CONFLICT: 'Conflict: the resource changed in the meantime.',
    E_BUSY: 'The agent is busy, please retry.',
    E_TIMEOUT: 'The operation timed out.',
    E_CANCELLED: 'The operation was cancelled.',
    E_IO: 'Disk or network error.',
    // Variantes `E_IO_<reason>` : la cause système exacte, avec le geste qui répare.
    E_IO_EACCES:
      'Permission denied on {{path}} — the agent runs as "{{user}}", which cannot write there. Give that account access (for example: sudo chown -R {{user}} <server folder>), or reinstall the agent under the account that owns the servers.',
    E_IO_EPERM:
      'Operation not permitted on {{path}} — the agent runs as "{{user}}". Check the owner and permissions of that folder.',
    E_IO_EROFS: '{{path}} is on a read-only filesystem.',
    E_IO_ENOSPC: 'No space left on the device holding {{path}}.',
    E_IO_ENOTDIR: '{{path}} is not a directory.',
    // Lot 4 — gardes de sauvegarde : refus AVANT d'écrire, avec les nombres qui permettent d'agir.
    E_IO_INSUFFICIENT_SPACE:
      'Not enough free space for the backup on {{path}}: about {{requiredMb}} MB needed (estimated), {{freeMb}} MB free. Nothing was written. Free some space or change the backup destination.',
    E_IO_DESTINATION_UNMARKED:
      'The backup destination {{path}} has no marker file ({{marker}}): the folder is probably not mounted, or was replaced. Nothing was written. Mount it and retry; if it really is the right folder, create an empty file named {{marker}} at its root, or remove the destination from the settings and set it again.',
    E_PORT_IN_USE: 'Port {{port}} is already in use.',
    E_RAM_GUARD: 'Not enough free memory: {{needMb}} MB needed, {{freeMb}} MB available.',
    E_EULA_REQUIRED: 'The Minecraft EULA must be accepted before starting the server.',
    E_JAVA_UNAVAILABLE: 'No suitable Java runtime (Java {{majorVersion}}) is available.',
    E_CHECKSUM_MISMATCH: 'Checksum mismatch — the file is corrupted.',
    E_INTERRUPTED: 'The operation was interrupted; it can be retried.',
    E_PRECHECK_FAILED: 'Pre-checks on the target machine failed.',
    E_SIGNATURE_INVALID: 'Invalid bundle signature — update refused.',
    E_UNREACHABLE: 'No direct address reachable; relaying through the panel.',
    E_TOO_LARGE: 'The file or transfer exceeds the allowed size.',
    E_INTERNAL: 'Internal error.',
    // Codes propres au panel (`@mmo/protocol/client`, phase 4)
    E_FORBIDDEN: 'You do not have permission to do this.',
    E_RATE_LIMITED: 'Too many attempts — please wait a moment.',
    E_SETUP_REQUIRED: 'The panel has not been set up yet.',
    E_SETUP_DONE: 'The panel is already set up.',
    E_AGENT_OFFLINE: 'The agent of this machine is not connected.',
    E_VALIDATION: 'Invalid input.',
    E_NO_RELEASE: 'No agent release published on this panel.',
    /** Lot 4 — webhook URL refused by the SSRF guard (`details.reason`, key `url`). */
    E_VALIDATION_BAD_URL: 'This is not a valid URL.',
    E_VALIDATION_BAD_SCHEME: 'Only https:// addresses are accepted for a webhook.',
    E_VALIDATION_CREDENTIALS: 'A webhook URL must not carry credentials (user:password@).',
    E_VALIDATION_BLOCKED_HOST:
      'Host name refused ({{hostname}}): a webhook cannot target a local machine or the tailnet.',
    E_VALIDATION_BLOCKED_ADDRESS:
      '{{hostname}} resolves to a reserved address ({{address}}, {{range}}): a webhook can only target a public service.',
    E_VALIDATION_UNRESOLVABLE: 'The host name {{hostname}} does not resolve from the panel.',
    E_VALIDATION_NOT_DISCORD:
      'This is not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>).',
    E_VALIDATION_TOO_MANY: 'Maximum number of webhooks reached ({{max}}).',
    E_VALIDATION_NO_SECRET: 'A Discord webhook has no secret: only a signed JSON webhook has one.',
    /** Lot 4 — off-site copy. */
    E_VALIDATION_SAME_MACHINE:
      'The off-site copy must live on a different machine than the server.',
    E_VALIDATION_NO_DESTINATION: 'No off-site machine is configured for this server.',
    /** Lot 8 — per-server rights. */
    E_VALIDATION_ADMIN_SCOPED:
      'An administrator sees the whole panel: the account cannot be limited to some servers.',
    E_VALIDATION_GRANT_ABOVE_ROLE:
      'A granted role cannot exceed the role of the account (a viewer stays a viewer everywhere).',
    E_PUSH_DISABLED: 'Push notifications are not configured on this panel (VAPID keys missing).',
    E_ACCESS_NOT_CONFIGURED:
      'The access layer is not configured (domain, DNS provider or public URL missing).',
    E_ACME_FAILED: 'Certificate request failed: {{reason}}',
    E_DNS_FAILED: 'DNS update failed: {{reason}}',
  },
  detection: {
    source: {
      libraries: 'libraries/ folder',
      run_script: 'run script',
      jar_name: 'jar file name',
      jar_manifest: 'jar manifest',
      install_properties: 'Fabric install.properties',
      version_json: 'version.json inside the server jar',
      versions_dir: 'versions/ folder',
      variables_txt: 'variables.txt (ServerPackCreator)',
      server_setup_config: 'server-setup-config.yaml (FTB)',
      installer_name: 'installer file name',
      latest_log: 'logs/latest.log',
      mods: 'mods/ folder',
      user_jvm_args: 'user_jvm_args.txt',
      settings_script: 'settings script',
      script: 'start script',
      server_properties: 'server.properties',
      default: 'default value',
      override: 'manual override',
      manifest: 'Mojang version manifest',
      table: 'built-in compatibility table',
    },
    evidence: {
      neoforge_libraries: 'NeoForge libraries found ({{detail}})',
      forge_libraries: 'Forge libraries found ({{detail}})',
      forge_argfiles: 'Forge/NeoForge argument files found ({{detail}})',
      forge_universal_jar: 'Forge universal jar found ({{detail}})',
      forge_installer_only: 'Forge/NeoForge installer present but not installed ({{detail}})',
      fabric_launcher: 'Fabric server launcher found ({{detail}})',
      fabric_dir: '.fabric/ folder found',
      vanilla_jar: 'Vanilla server jar found ({{detail}})',
      serverstarterjar: 'server.jar is a NeoForge ServerStarterJar, not a vanilla server',
      mods_vote: 'mods/ descriptors point to {{detail}}',
      mods_mismatch: 'mods/ descriptors disagree with the detected loader ({{detail}})',
      mods_ambiguous: 'mods/ descriptors are ambiguous ({{detail}})',
      variables_txt: 'variables.txt declares {{detail}}',
      server_setup_config: 'server-setup-config.yaml declares {{detail}}',
      version_conflict: 'conflicting Minecraft versions found ({{detail}})',
      version_confirmed: 'Minecraft version confirmed by {{detail}}',
      log_version: 'logs/latest.log mentions version {{detail}}',
      ram_from: 'memory settings read from {{detail}}',
      ram_default: 'no memory setting found — default proposed',
      ram_ambiguous: 'several memory settings found ({{detail}})',
      eula_accepted: 'EULA accepted',
      eula_missing: 'EULA not accepted yet',
      velocity_toml: 'velocity.toml found — Velocity proxy ({{detail}})',
      marker: 'MMO marker found ({{detail}})',
      no_loader: 'no loader signal found — configure manually',
      no_version: 'Minecraft version not found — configure manually',
    },
    needsInstall: 'The loader has not been installed yet (installer present, libraries/ missing).',
  },
} as const;

/** Forme des ressources : mêmes clés, feuilles textuelles. */
export type Resources = DeepStrings<typeof en>;
type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };
