import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  OverwriteType,
  Partials,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client as DiscordClient,
  type Collection,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type User,
  type UserSelectMenuInteraction,
  type VoiceBasedChannel,
  type VoiceState,
  type OverwriteResolvable,
} from "discord.js";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  db,
  discordSanctionsTable,
  discordSecurityDetectionsTable,
  discordLevelsTable,
  discordMemberProfilesTable,
  discordCustomRolesTable,
  discordReportsTable,
  discordReportNotesTable,
  discordMissionsTable,
  discordMissionProgressTable,
  discordMissionPublicationsTable,
  discordAuditLogsTable,
  discordSecurityConfigsTable,
  discordBotMaintenanceTable,
  discordGuildConfigsTable,
  discordBadgesTable,
  discordMemberBadgesTable,
  discordGuardianProfilesTable,
  discordBackupsTable,
  type NewDiscordSanction,
  type NewDiscordLevel,
} from "@workspace/db";
import { logger } from "./logger";
import {
  calculateLevel,
  buildEightBallResponseFields,
  getCurrentWeeklyMissionPeriod,
  getNextMonthlyLeaderboardRun,
  getNextWeeklyMissionRun,
  getImageAttachmentUrls,
  guardianLevelForXp,
  isBurst,
  levelTiersForLevel,
  parseDuration,
  nextMissionProgress,
  securityEscalationForDetectionCount,
  shouldLogMessageUpdate,
  trimWindow,
  xpForLevel,
  xpNeededForLevel,
} from "./discord-bot-utils";
import {
  extractDiscordId,
  shouldDeletePrefixCommand,
  tokenizePrefixCommand,
} from "./discord-prefix";
import {
  buildHelpPage,
  HELP_PAGE_BUTTON_PREFIX,
  normalizeHelpPage,
} from "./discord-help";
import {
  buildServerConfigStatus,
  normalizeServerConfigPage,
  SERVER_CONFIG_PAGE_BUTTON_PREFIX,
} from "./discord-server-config";

const LOG_CHANNEL_NAME = "logs";
const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;
const FEATURE_LOG_CHANNEL_ID =
  process.env.DISCORD_FEATURE_LOG_CHANNEL_ID ?? "1534531636308344873";
let activeDiscordClient: DiscordClient<boolean> | null = null;
const LOG_CHANNEL_IDS = {
  messages: process.env.DISCORD_MESSAGE_LOG_CHANNEL_ID ?? LOG_CHANNEL_ID,
  sanctions:
    process.env.DISCORD_SANCTION_LOG_CHANNEL_ID ?? "1527710965011845253",
  arrivals: process.env.DISCORD_JOIN_LEAVE_LOG_CHANNEL_ID ?? LOG_CHANNEL_ID,
  // Par défaut, mêmes salon/variable que "arrivals" (comportement inchangé).
  // Mets DISCORD_LEAVE_LOG_CHANNEL_ID si tu veux un salon dédié aux départs.
  departures:
    process.env.DISCORD_LEAVE_LOG_CHANNEL_ID ??
    process.env.DISCORD_JOIN_LEAVE_LOG_CHANNEL_ID ??
    LOG_CHANNEL_ID,
  locks: process.env.DISCORD_LOCK_LOG_CHANNEL_ID ?? "1533097580546883584",
  tempVoice:
    process.env.DISCORD_TEMP_VOICE_LOG_CHANNEL_ID ?? "1513977219566014645",
  customRoles: process.env.DISCORD_CUSTOM_ROLE_LOG_CHANNEL_ID ?? LOG_CHANNEL_ID,
  leaderboard:
    process.env.DISCORD_LEADERBOARD_LOG_CHANNEL_ID ?? LOG_CHANNEL_ID,
  polls: process.env.DISCORD_POLL_LOG_CHANNEL_ID ?? "1533543801656840193",
  games: process.env.DISCORD_GAMES_LOG_CHANNEL_ID ?? "1533547458213318727",
  startup:
    process.env.DISCORD_STARTUP_LOG_CHANNEL_ID ?? "1533755461659267232",
  features: FEATURE_LOG_CHANNEL_ID,
} as const;

const VOICE_HUB_CHANNEL_ID =
  process.env.DISCORD_VOICE_HUB_CHANNEL_ID ?? "1533103073868644493";

const TEMP_VOICE_CHANNEL_IDS = new Set<string>();

// 👉 Personnalise ici le statut affiché par le bot ("Diffuse en direct : ...")
// et l'URL associée (doit être une URL Twitch ou YouTube valide pour que
// Discord affiche bien le badge "En direct").
const BOT_STATUS_TEXT =
  process.env.DISCORD_STATUS_TEXT ??
  "https://discord.gg/Afwy52gFcM";
const BOT_STATUS_URL =
  process.env.DISCORD_STATUS_URL ?? "https://discord.gg/Afwy52gFcM";

// Lien d'appel envoyé en MP lors d'un mute, kick ou ban.
const APPEAL_SERVER_INVITE =
  process.env.DISCORD_APPEAL_SERVER_INVITE ?? "https://discord.gg/ag7WExkGKF";

// 👉 Personnalise ici le message envoyé quand quelqu'un ping le bot.
const BOT_MENTION_MESSAGE =
  process.env.DISCORD_MENTION_MESSAGE ??
  "👋 Salut ! Utilise `*help` pour voir toutes mes commandes. Annonces du bot dans un salon spécial : annonces-bot";

const WELCOME_CHANNEL_ID = process.env.DISCORD_WELCOME_CHANNEL_ID;
const WELCOME_MESSAGE =
  process.env.DISCORD_WELCOME_MESSAGE ??
  "Bienvenue {member} sur **{server}** ! Utilise `*help` pour découvrir CosmoBot.";
const ONBOARDING_ROLE_ID = process.env.DISCORD_ONBOARDING_ROLE_ID;
const RAID_JOIN_WINDOW_MS = 60 * 1000;
const RAID_JOIN_THRESHOLD = 5;
const SPAM_WINDOW_MS = 10 * 1000;
const SPAM_TIMEOUT_MINUTES = 5;
const SECURITY_TEMP_BAN_MINUTES = 24 * 60;
const SECURITY_DETECTION_TEMP_BAN_THRESHOLD = 3;
const SECURITY_DETECTION_PERMANENT_BAN_THRESHOLD = 5;
const MIN_SPAM_THRESHOLD = 10;
const MAX_SPAM_THRESHOLD = 15;
const ANTI_NUKE_WINDOW_MS = 5 * 1000;
const DEFAULT_ANTI_NUKE_THRESHOLD = 3;
const ANTI_NUKE_ACTIONS = new Set<AuditLogEvent>([
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.WebhookUpdate,
  AuditLogEvent.EmojiDelete,
  AuditLogEvent.EmojiUpdate,
  AuditLogEvent.MessageBulkDelete,
  AuditLogEvent.ThreadDelete,
  AuditLogEvent.ThreadUpdate,
]);
const SECURITY_ALERT_COOLDOWN_MS = 60 * 1000;
const SECURITY_JOIN_WINDOWS = new Map<string, number[]>();
const SECURITY_JOIN_MEMBERS = new Map<
  string,
  Array<{ userId: string; timestamp: number }>
>();
const SECURITY_RAID_BURST_HANDLED_AT = new Map<string, number>();
const SECURITY_MESSAGE_WINDOWS = new Map<string, number[]>();
const SECURITY_ALERT_COOLDOWNS = new Map<string, number>();
const SECURITY_LOCKDOWNS = new Set<string>();
const SECURITY_NUKE_WINDOWS = new Map<string, number[]>();
const SECURITY_NUKE_HANDLED = new Set<string>();
const AUTOMATED_SANCTION_COOLDOWNS = new Map<string, number>();
const AUTOMATED_SANCTION_COOLDOWN_MS = 10 * 60 * 1000;
const SECURITY_TEMP_BAN_TIMEOUTS = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const SECURITY_ESCALATION_HANDLED = new Set<string>();
const INITIALIZED_BADGE_GUILDS = new Set<string>();

const CUSTOMROLE_MENU_SELECT_ID = "customrole_menu_select";
const CUSTOMROLE_CREATE_MODAL_ID = "customrole_create_modal";
const CUSTOMROLE_REMOVE_SELECT_ID = "customrole_remove_select";

// --- Cosmo Shield / Cosmo Missions ---
// Les ressources Cosmo sont réutilisées au démarrage. Le salon de signalements
// est volontairement adressé par ID pour éviter qu'un changement de nom crée
// un doublon.
const COSMO_CATEGORY_NAME =
  process.env.COSMO_CATEGORY_NAME ?? "Cosmo Shield";
const COSMO_REPORTS_CHANNEL_ID = "1534499107559968788";
const COSMO_MISSIONS_CHANNEL_NAME =
  process.env.COSMO_MISSIONS_CHANNEL_NAME ?? "missions";
const COSMO_GLOBAL_MISSIONS_CHANNEL_NAME =
  process.env.COSMO_GLOBAL_MISSIONS_CHANNEL_NAME ?? "missions-globales";
const COSMO_MISSIONS_CHANNEL_ID =
  process.env.COSMO_MISSIONS_CHANNEL_ID ?? "1534499110181408768";
const COSMO_GLOBAL_MISSIONS_CHANNEL_ID =
  process.env.COSMO_GLOBAL_MISSIONS_CHANNEL_ID ?? "1534502858744135760";
const COSMO_MODERATOR_ROLE_NAME =
  process.env.COSMO_MODERATOR_ROLE_NAME ?? "Cosmo Modération";
const COSMO_GUARDIAN_ROLE_NAME =
  process.env.COSMO_GUARDIAN_ROLE_NAME ?? "Cosmo Gardien";
const COSMO_DEFAULT_MISSION_DAYS = 7;
const COSMO_REPORT_COOLDOWN_MS = 60 * 60 * 1000;
const COSMO_REPORT_COOLDOWNS = new Map<string, number>();

const COSMO_REPORT_BUTTON_PREFIX = "cosmo_report_";
const COSMO_MISSION_JOIN_PREFIX = "cosmo_mission_join_";

type CosmoResources = {
  categoryId: string;
  reportsChannelId: string;
  missionsChannelId: string;
  globalMissionsChannelId: string;
  moderatorRoleId: string;
  guardianRoleId: string;
};

const COSMO_RESOURCES = new Map<string, CosmoResources>();

async function getOrCreateCosmoRole(
  guild: Guild,
  name: string,
  color: number,
) {
  const existing = guild.roles.cache.find((role) => role.name === name);
  if (existing) {
    return existing;
  }

  return guild.roles.create({
    name,
    colors: { primaryColor: color },
    reason: "Configuration automatique de Cosmo Shield",
  });
}

async function getConfiguredCosmoChannel(
  guild: Guild,
  channelId: string,
  label: string,
): Promise<TextChannel> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
    throw new Error(
      `Le salon Cosmo configuré pour ${label} est introuvable ou invalide : ${channelId}.`,
    );
  }
  return channel;
}

async function getOrCreateCosmoChannel(
  guild: Guild,
  name: string,
  parentId: string,
  permissionOverwrites: readonly OverwriteResolvable[],
): Promise<TextChannel> {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === name &&
      channel.parentId === parentId,
  );
  if (existing && existing.type === ChannelType.GuildText) {
    return existing;
  }

  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites,
    reason: "Configuration automatique de Cosmo Shield",
  });
}

async function ensureCosmoResources(guild: Guild): Promise<CosmoResources> {
  const cached = COSMO_RESOURCES.get(guild.id);
  if (cached) {
    return cached;
  }

  const moderatorRole = await getOrCreateCosmoRole(
    guild,
    COSMO_MODERATOR_ROLE_NAME,
    0xe74c3c,
  );
  const guardianRole = await getOrCreateCosmoRole(
    guild,
    COSMO_GUARDIAN_ROLE_NAME,
    0xf1c40f,
  );

  let category = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name === COSMO_CATEGORY_NAME,
  );
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({
      name: COSMO_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Configuration automatique de Cosmo Shield",
    });
  }

  const botId = guild.client.user?.id;
  const missionsOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [PermissionFlagsBits.SendMessages],
    },
    {
      id: moderatorRole.id,
      allow: [PermissionFlagsBits.SendMessages],
    },
    ...(botId
      ? [
          {
            id: botId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ]
      : []),
  ];

  const settings = await getGuildSettings(guild.id);
  const cosmoChannelOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...(botId
      ? [
          {
            id: botId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ]
      : []),
  ];
  const reportsChannel = settings.channelIds.cosmoReports
    ? await getConfiguredCosmoChannel(
        guild,
        settings.channelIds.cosmoReports,
        "les signalements",
      )
    : await getOrCreateCosmoChannel(
        guild,
        "signalements",
        category.id,
        cosmoChannelOverwrites,
      );
  const missionsChannel = settings.channelIds.cosmoMissions
    ? await getConfiguredCosmoChannel(
        guild,
        settings.channelIds.cosmoMissions,
        "les missions",
      )
    : await getOrCreateCosmoChannel(
        guild,
        COSMO_MISSIONS_CHANNEL_NAME,
        category.id,
        missionsOverwrites,
      );
  const globalMissionsChannel = settings.channelIds.cosmoGlobalMissions
    ? await getConfiguredCosmoChannel(
        guild,
        settings.channelIds.cosmoGlobalMissions,
        "les missions globales",
      )
    : await getOrCreateCosmoChannel(
        guild,
        COSMO_GLOBAL_MISSIONS_CHANNEL_NAME,
        category.id,
        missionsOverwrites,
      );

  const resources: CosmoResources = {
    categoryId: category.id,
    reportsChannelId: reportsChannel.id,
    missionsChannelId: missionsChannel.id,
    globalMissionsChannelId: globalMissionsChannel.id,
    moderatorRoleId: moderatorRole.id,
    guardianRoleId: guardianRole.id,
  };
  COSMO_RESOURCES.set(guild.id, resources);
  return resources;
}

async function hasCosmoModeratorAccess(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (await isBotOwnerInteraction(interaction)) {
    return true;
  }
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const guild = interaction.guild;
  if (!guild) {
    return false;
  }

  const resources = await ensureCosmoResources(guild);
  const settings = await getGuildSettings(guild.id);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(
    member?.roles.cache.has(resources.moderatorRoleId) ||
      (settings.roleIds.warn && member?.roles.cache.has(settings.roleIds.warn)),
  );
}

// Sanctions qui annulent une sanction précédente (unwarn, demute, unban).
// Elles sont affichées en vert et exclues de la liste globale de /sanctions.
const REVERSAL_SANCTION_ACTIONS = ["unwarn", "unmute", "unban"] as const;
const REVERSAL_SANCTION_COLOR = 0x2ecc71;
const DEFAULT_SANCTION_COLOR = 0xc0392b;

function isReversalSanction(action: string): boolean {
  return (REVERSAL_SANCTION_ACTIONS as readonly string[]).includes(action);
}

// Rôles personnalisés temporaires créés via /customrole. Fonctionnent en
// mémoire et survivent désormais aux redémarrages grâce à la persistance.
type CustomRoleState = {
  roleId: string;
  guildId: string;
  ownerId: string;
  name: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

const ACTIVE_CUSTOM_ROLES = new Map<string, CustomRoleState>();
const CUSTOM_ROLE_MIN_DURATION_MS = 60 * 1000; // 1 minute
const CUSTOM_ROLE_MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 365 jours

function scheduleCustomRoleExpiration(
  client: DiscordClient<boolean>,
  state: CustomRoleState,
  targetTime = state.expiresAt,
) {
  if (state.timeout) {
    clearTimeout(state.timeout);
  }

  state.timeout = scheduleAt(targetTime, () => {
    expireCustomRole(client, state.roleId).catch((err) => {
      logger.error(
        { err, roleId: state.roleId },
        "Failed to auto-expire custom role",
      );
    });
  });
}

function parseHexColor(input: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  return match ? parseInt(match[1], 16) : null;
}

const MODERATION_ROLE_IDS = {
  warn: process.env.DISCORD_WARN_ROLE_ID,
  unwarn: process.env.DISCORD_WARN_ROLE_ID,
  mute: process.env.DISCORD_MUTE_ROLE_ID,
  demute: process.env.DISCORD_MUTE_ROLE_ID,
  kick: process.env.DISCORD_KICK_ROLE_ID,
  ban: process.env.DISCORD_BAN_ROLE_ID,
  unban: process.env.DISCORD_BAN_ROLE_ID,
  lock: process.env.DISCORD_LOCK_ROLE_ID,
  unlock: process.env.DISCORD_LOCK_ROLE_ID,
} as const;

const UNIQUE_MODERATION_ROLE_IDS = Array.from(
  new Set(
    Object.values(MODERATION_ROLE_IDS).filter((roleId): roleId is string =>
      Boolean(roleId),
    ),
  ),
);

// Rôles requis par commande, en plus de MODERATION_ROLE_IDS. Séparé de
// MODERATION_ROLE_IDS pour ne pas faire bénéficier ce rôle du contournement
// de /lock accordé aux rôles de modération (voir UNIQUE_MODERATION_ROLE_IDS).
const COMMAND_ROLE_IDS = {
  ...MODERATION_ROLE_IDS,
  customrole: process.env.DISCORD_ROLE_ROLE_ID,
  helpstaff: process.env.DISCORD_WARN_ROLE_ID,
  abs: process.env.DISCORD_WARN_ROLE_ID,
  clear: process.env.DISCORD_CLEAR_ROLE_ID,
  clearmember: process.env.DISCORD_CLEAR_ROLE_ID,
  sanctions: process.env.DISCORD_WARN_ROLE_ID,
  rank: process.env.DISCORD_MEMBRES_ROLE_ID,
} as const;

// Commandes accessibles avec AU MOINS UN des rôles listés (au lieu d'un
// rôle unique comme COMMAND_ROLE_IDS). /editsanction : mute OU ban.
const COMMAND_ANY_ROLE_IDS: Partial<Record<string, string[]>> = {
  editsanction: [
    process.env.DISCORD_BAN_ROLE_ID,
    process.env.DISCORD_MUTE_ROLE_ID,
  ].filter((roleId): roleId is string => Boolean(roleId)),
};

// Les 3 rôles affichés en colonnes par /server, avec la liste de leurs
// membres. Modifie ces IDs directement ici pour changer les rôles affichés.
const SERVER_STAFF_COLUMN_ROLE_IDS = [
  "1526941582467665983",
  "1518351537578053793",
  "1513149966523174982",
];

const LOCK_TARGET_ROLE_IDS = [
  process.env.DISCORD_MEMBRETEMPO_ROLE_ID,
  process.env.DISCORD_MEMBRES_ROLE_ID,
].filter((roleId): roleId is string => Boolean(roleId));

// --- Absences ---
const ABSENCE_LOG_CHANNEL_ID =
  process.env.DISCORD_ABSENCE_LOG_CHANNEL_ID ?? "1533140501656506460";
const ABSENCE_PING_ROLE_ID =
  process.env.DISCORD_ABSENCE_PING_ROLE_ID ?? "1526941582467665983";
const ABSENCE_COMMAND_CHANNEL_ID =
  process.env.DISCORD_ABSENCE_COMMAND_CHANNEL_ID ?? "1525225908229636241";

// Salon depuis lequel /helpstaff doit être utilisée (salon "cmds-staff").
// Si non configurée, la commande reste utilisable partout.
const STAFF_COMMANDS_CHANNEL_ID = process.env.DISCORD_STAFF_COMMANDS_CHANNEL_ID;

// Chemin vers le fichier source du bot, utilisé par /server pour afficher
// son nombre de lignes. Par défaut, on suppose qu'il est déployé tel quel
// à la racine sous le nom discord-bot.ts ; surcharge possible via env si
// le déploiement diffère.
const BOT_SOURCE_FILE_PATH =
  process.env.DISCORD_SOURCE_FILE_PATH ??
  path.resolve(process.cwd(), "src/lib/discord-bot.ts");
const BOT_SOURCE_FILE_CANDIDATES = [
  BOT_SOURCE_FILE_PATH,
  path.resolve(process.cwd(), "artifacts/api-server/src/lib/discord-bot.ts"),
  path.resolve(process.cwd(), "discord-bot.ts"),
];

async function getBotSourceLineCount(): Promise<number | null> {
  for (const filePath of BOT_SOURCE_FILE_CANDIDATES) {
    try {
      const content = await fsPromises.readFile(filePath, "utf8");
      return content.split("\n").length;
    } catch {
      continue;
    }
  }

  return null;
}

// --- Système de niveaux ---
const XP_MIN_PER_MESSAGE = 30;
const XP_MAX_PER_MESSAGE = 50;
const XP_MESSAGE_COOLDOWN_MS = 60 * 1000; // 1 minute entre 2 gains d'XP
const LEVEL_TIER_SIZE = 10; // un nouveau palier tous les 10 niveaux
const LEGACY_LEVEL_UP_CHANNEL_ID =
  process.env.DISCORD_LEVEL_UP_CHANNEL_ID ?? "1512177979210338314";

// Rôle attribué à chaque palier (tier 1 = niveaux 1-9, tier 2 = niveaux 10-19,
// ... tier 20 = niveau 190+).
// Ajoute DISCORD_LEVEL_TIER_<n>_ROLE_ID dans tes variables d'environnement
// pour chaque palier que tu veux configurer.
const MAX_LEVEL_TIERS = 20;
const LEGACY_LEVEL_TIER_ROLE_IDS: Record<number, string> = {};
for (let tier = 1; tier <= MAX_LEVEL_TIERS; tier++) {
  const roleId = process.env[`DISCORD_LEVEL_TIER_${tier}_ROLE_ID`];
  if (roleId) {
    LEGACY_LEVEL_TIER_ROLE_IDS[tier] = roleId;
  }
}

// --- Classement mensuel ---
// Salon où le classement mensuel est annoncé (avec ping) le 1er de chaque mois.
const MONTHLY_LEADERBOARD_CHANNEL_ID =
  process.env.DISCORD_MONTHLY_LEADERBOARD_CHANNEL_ID ??
  "1512166645450280990";
// Rôle pingé lors de l'annonce mensuelle (par défaut, le rôle "membres" déjà
// utilisé pour /lock — configure DISCORD_MONTHLY_LEADERBOARD_PING_ROLE_ID
// si tu veux pinger un rôle différent).
const MONTHLY_LEADERBOARD_PING_ROLE_ID =
  process.env.DISCORD_MONTHLY_LEADERBOARD_PING_ROLE_ID ??
  process.env.DISCORD_MEMBRES_ROLE_ID;
// Nombre de membres affichés dans le classement mensuel.
const MONTHLY_LEADERBOARD_SIZE = 10;
// 👉 Rôle attribué chaque mois au Top 1 du classement XP. Il est retiré à
// l'ancien détenteur puis réattribué au nouveau Top 1 le 1er de chaque
// mois — mets l'ID de ton rôle "Top 1 XP" ici ou dans la variable
// d'environnement DISCORD_TOP_XP_ROLE_ID. Tant qu'il n'est pas configuré,
// le classement est quand même annoncé, mais aucun rôle n'est attribué.
const TOP_XP_ROLE_ID =
  process.env.DISCORD_TOP_XP_ROLE_ID ?? "1533198425666093268";

// Anti-spam : empêche de gagner de l'XP en boucle sur des messages rapides.
const XP_COOLDOWNS = new Map<string, number>();

// --- Réaction automatique ---
// Salon où le bot réagit automatiquement à chaque message avec l'emoji
// configuré ci-dessous (doit être un emoji custom présent sur CE serveur).
const AUTO_REACT_CHANNEL_ID =
  process.env.DISCORD_AUTO_REACT_CHANNEL_ID ?? "1526936818367336571";
// 👉 Nom de l'emoji custom (sans les deux-points). Change-le ici ou via
// DISCORD_AUTO_REACT_EMOJI_NAME si le nom exact diffère sur ton serveur.
const AUTO_REACT_EMOJI_NAME =
  process.env.DISCORD_AUTO_REACT_EMOJI_NAME ?? "checking";

// Rôle dont la permission "Intégrer des liens" (GIFs, embeds...) est retirée
// pendant un /lock, puis restaurée à /unlock.
const GIF_PERM_ROLE_ID = process.env.DISCORD_ROLE_PERM_GIF_ID;

type GuildSettings = {
  logChannels: Record<string, string | null>;
  roleIds: Record<string, string | null>;
  levelTierRoleIds: Record<number, string | null>;
  channelIds: Record<string, string | null>;
  autoReactEmojiName: string;
  welcomeMessage: string;
  maintenanceEnabled: boolean;
};

const LEGACY_CONFIGURATION_GUILD_ID =
  process.env.DISCORD_PRIMARY_GUILD_ID ?? "1512127310218924082";
const GUILD_SETTINGS_CACHE = new Map<string, GuildSettings>();

function emptyGuildSettings(): GuildSettings {
  return {
    logChannels: {},
    roleIds: {},
    levelTierRoleIds: {},
    channelIds: {},
    autoReactEmojiName: "checking",
    welcomeMessage:
      "Bienvenue {member} sur **{server}** ! Utilise `*help` pour découvrir CosmoBot.",
    maintenanceEnabled: false,
  };
}

function legacyGuildSettings(): GuildSettings {
  return {
    logChannels: Object.fromEntries(
      Object.entries(LOG_CHANNEL_IDS).map(([key, value]) => [key, value ?? null]),
    ),
    roleIds: {
      ...Object.fromEntries(
        Object.entries(MODERATION_ROLE_IDS).map(([key, value]) => [
          key,
          value ?? null,
        ]),
      ),
      customrole: process.env.DISCORD_ROLE_ROLE_ID ?? null,
      clear: process.env.DISCORD_CLEAR_ROLE_ID ?? null,
      clearmember: process.env.DISCORD_CLEAR_ROLE_ID ?? null,
      members: process.env.DISCORD_MEMBRES_ROLE_ID ?? null,
      memberTempo: process.env.DISCORD_MEMBRETEMPO_ROLE_ID ?? null,
      gif: GIF_PERM_ROLE_ID ?? null,
      absencePing: ABSENCE_PING_ROLE_ID,
      monthlyLeaderboardPing: MONTHLY_LEADERBOARD_PING_ROLE_ID ?? null,
      topXp: TOP_XP_ROLE_ID ?? null,
    },
    levelTierRoleIds: Object.fromEntries(
      Object.entries(LEGACY_LEVEL_TIER_ROLE_IDS).map(([tier, roleId]) => [
        Number(tier),
        roleId,
      ]),
    ),
    channelIds: {
      voiceHub: VOICE_HUB_CHANNEL_ID,
      welcome: WELCOME_CHANNEL_ID ?? null,
      absenceLog: ABSENCE_LOG_CHANNEL_ID,
      absenceCommand: ABSENCE_COMMAND_CHANNEL_ID,
      autoReact: AUTO_REACT_CHANNEL_ID,
      monthlyLeaderboard: MONTHLY_LEADERBOARD_CHANNEL_ID,
      announcePoll: ANNOUNCE_POLL_CHANNEL_ID,
      cosmoReports: COSMO_REPORTS_CHANNEL_ID,
      cosmoMissions: COSMO_MISSIONS_CHANNEL_ID,
      cosmoGlobalMissions: COSMO_GLOBAL_MISSIONS_CHANNEL_ID,
      levelUp: LEGACY_LEVEL_UP_CHANNEL_ID,
    },
    autoReactEmojiName: AUTO_REACT_EMOJI_NAME,
    welcomeMessage: WELCOME_MESSAGE,
    maintenanceEnabled: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGuildSettings(
  guildId: string,
  stored: unknown,
): GuildSettings {
  const base =
    guildId === LEGACY_CONFIGURATION_GUILD_ID
      ? legacyGuildSettings()
      : emptyGuildSettings();
  if (!isRecord(stored)) {
    return base;
  }

  const storedLogChannels = isRecord(stored.logChannels)
    ? stored.logChannels
    : {};
  const storedRoleIds = isRecord(stored.roleIds) ? stored.roleIds : {};
  const storedLevelTierRoleIds = isRecord(stored.levelTierRoleIds)
    ? stored.levelTierRoleIds
    : {};
  const storedChannelIds = isRecord(stored.channelIds)
    ? stored.channelIds
    : {};

  return {
    ...base,
    logChannels: {
      ...base.logChannels,
      ...storedLogChannels,
    } as Record<string, string | null>,
    roleIds: {
      ...base.roleIds,
      ...storedRoleIds,
    } as Record<string, string | null>,
    levelTierRoleIds: Object.fromEntries(
      Object.entries({
        ...base.levelTierRoleIds,
        ...storedLevelTierRoleIds,
      }).map(([tier, roleId]) => [
        Number(tier),
        typeof roleId === "string" ? roleId : null,
      ]),
    ),
    channelIds: {
      ...base.channelIds,
      ...storedChannelIds,
    } as Record<string, string | null>,
    autoReactEmojiName:
      typeof stored.autoReactEmojiName === "string"
        ? stored.autoReactEmojiName
        : base.autoReactEmojiName,
    welcomeMessage:
      typeof stored.welcomeMessage === "string"
        ? stored.welcomeMessage
        : base.welcomeMessage,
    maintenanceEnabled:
      typeof stored.maintenanceEnabled === "boolean"
        ? stored.maintenanceEnabled
        : base.maintenanceEnabled,
  };
}

async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const cached = GUILD_SETTINGS_CACHE.get(guildId);
  if (cached) {
    return cached;
  }

  const [row] = await db
    .select({ settings: discordGuildConfigsTable.settings })
    .from(discordGuildConfigsTable)
    .where(eq(discordGuildConfigsTable.guildId, guildId))
    .limit(1);
  const settings = normalizeGuildSettings(guildId, row?.settings);
  GUILD_SETTINGS_CACHE.set(guildId, settings);
  return settings;
}

async function saveGuildSettings(guildId: string, settings: GuildSettings) {
  GUILD_SETTINGS_CACHE.set(guildId, settings);
  await db
    .insert(discordGuildConfigsTable)
    .values({
      guildId,
      settings,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discordGuildConfigsTable.guildId,
      set: { settings, updatedAt: new Date() },
    });
}

function getGuildRoleIds(settings: GuildSettings) {
  return settings.roleIds;
}

function getGuildLockTargetRoleIds(settings: GuildSettings) {
  return [settings.roleIds.memberTempo, settings.roleIds.members].filter(
    (roleId): roleId is string => Boolean(roleId),
  );
}

function getGuildModerationRoleIds(settings: GuildSettings) {
  return Object.values({
    warn: settings.roleIds.warn,
    mute: settings.roleIds.mute,
    kick: settings.roleIds.kick,
    ban: settings.roleIds.ban,
    lock: settings.roleIds.lock,
    unlock: settings.roleIds.unlock,
  }).filter((roleId): roleId is string => Boolean(roleId));
}

const SERVER_CONFIG_KEYS = [
  "log.messages",
  "log.sanctions",
  "log.arrivals",
  "log.departures",
  "log.locks",
  "log.tempVoice",
  "log.customRoles",
  "log.leaderboard",
  "log.polls",
  "log.games",
  "log.startup",
  "log.features",
  "role.warn",
  "role.mute",
  "role.kick",
  "role.ban",
  "role.lock",
  "role.unlock",
  "role.members",
  "role.memberTempo",
  "role.gif",
  "role.absencePing",
  "role.monthlyLeaderboardPing",
  "role.topXp",
  "role.onboarding",
  "channel.voiceHub",
  "channel.welcome",
  "channel.absenceLog",
  "channel.absenceCommand",
  "channel.autoReact",
  "channel.monthlyLeaderboard",
  "channel.announcePoll",
  "channel.cosmoReports",
  "channel.cosmoMissions",
  "channel.cosmoGlobalMissions",
  "channel.levelUp",
  "setting.autoReactEmoji",
  "setting.welcomeMessage",
] as const;

type ServerConfigKey = (typeof SERVER_CONFIG_KEYS)[number];

function getServerConfigValue(settings: GuildSettings, key: ServerConfigKey) {
  const [section, name] = key.split(".");
  if (section === "log") return settings.logChannels[name] ?? null;
  if (section === "role") return settings.roleIds[name] ?? null;
  if (section === "channel") return settings.channelIds[name] ?? null;
  if (name === "autoReactEmoji") return settings.autoReactEmojiName;
  if (name === "welcomeMessage") return settings.welcomeMessage;
  return null;
}

async function validateGuildConfigValue(
  guild: Guild,
  key: ServerConfigKey,
  value: string | null,
): Promise<string | null> {
  if (value === null) {
    return null;
  }

  const [section] = key.split(".");
  if (section === "role") {
    const role = await guild.roles.fetch(value).catch(() => null);
    if (!role || role.guild.id !== guild.id) {
      throw new Error(`Le rôle \`${value}\` n’appartient pas à ce serveur.`);
    }
    return role.id;
  }

  if (section === "channel" || section === "log") {
    const channel = await guild.channels.fetch(value).catch(() => null);
    if (!channel || channel.guildId !== guild.id) {
      throw new Error(`Le salon \`${value}\` n’appartient pas à ce serveur.`);
    }
    return channel.id;
  }

  return value;
}

async function handleServerConfigCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "status") {
    const status = buildServerConfigStatus(
      guild.name,
      SERVER_CONFIG_KEYS,
      (key) => getServerConfigValue(settings, key as ServerConfigKey),
      0,
    );
    await interaction.reply({
      embeds: status.embeds,
      components: status.components,
      ephemeral: true,
    });
    return;
  }

  const key = interaction.options.getString("key", true) as ServerConfigKey;
  if (!SERVER_CONFIG_KEYS.includes(key)) {
    await interaction.reply({
      content: `Clé invalide. Valeurs acceptées : ${SERVER_CONFIG_KEYS.join(", ")}`,
      ephemeral: true,
    });
    return;
  }

  const rawValue = interaction.options.getString("value", true);
  const rawValueOrNull = rawValue.toLowerCase() === "none" ? null : rawValue;
  let value: string | null;
  try {
    value = await validateGuildConfigValue(guild, key, rawValueOrNull);
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : "Valeur de configuration invalide.",
      ephemeral: true,
    });
    return;
  }
  const nextSettings: GuildSettings = {
    ...settings,
    logChannels: { ...settings.logChannels },
    roleIds: { ...settings.roleIds },
    channelIds: { ...settings.channelIds },
  };
  const [section, name] = key.split(".");
  if (section === "log") nextSettings.logChannels[name] = value;
  else if (section === "role") nextSettings.roleIds[name] = value;
  else if (section === "channel") nextSettings.channelIds[name] = value;
  else if (name === "autoReactEmoji") {
    nextSettings.autoReactEmojiName = value ?? "checking";
  } else if (name === "welcomeMessage") {
    nextSettings.welcomeMessage = value ?? emptyGuildSettings().welcomeMessage;
  }

  await saveGuildSettings(guild.id, nextSettings);
  await interaction.reply({
    content: `✅ Configuration \`${key}\` mise à jour pour **${guild.name}** : \`${value ?? "non configuré"}\``,
    ephemeral: true,
  });
}

function cloneGuildSettings(settings: GuildSettings): GuildSettings {
  return {
    ...settings,
    logChannels: { ...settings.logChannels },
    roleIds: { ...settings.roleIds },
    levelTierRoleIds: { ...settings.levelTierRoleIds },
    channelIds: { ...settings.channelIds },
  };
}

function configuredLevelTierRoleIds(settings: GuildSettings): string[] {
  return Array.from(
    new Set(
      Object.values(settings.levelTierRoleIds).filter(
        (roleId): roleId is string => Boolean(roleId),
      ),
    ),
  );
}

async function handleLevelRolesCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") {
    const lines = Array.from({ length: MAX_LEVEL_TIERS }, (_, index) => {
      const tier = index + 1;
      const roleId = settings.levelTierRoleIds[tier];
      const rangeStart = tier === 1 ? 1 : (tier - 1) * LEVEL_TIER_SIZE;
      const rangeEnd =
        tier === MAX_LEVEL_TIERS
          ? `${rangeStart}+`
          : `${tier * LEVEL_TIER_SIZE - 1}`;
      return `• Palier ${tier} (niveaux ${rangeStart}-${rangeEnd}) : ${
        roleId ? `<@&${roleId}>` : "non configuré"
      }`;
    });

    await interaction.reply({
      content: [
        `🎖️ Rôles de niveaux de **${guild.name}**`,
        `Palier 1 : niveaux 1-9, puis un nouveau palier tous les ${LEVEL_TIER_SIZE} niveaux jusqu’au palier 20 (niveau 190+).`,
        ...lines,
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "sync") {
    await interaction.deferReply({ ephemeral: true });
    const result = await reconcileGuildLevelTierRoles(guild);

    if (result.configuredRoleCount === 0) {
      await interaction.editReply(
        "⚠️ Aucun rôle de palier n’est configuré sur ce serveur. Utilise d’abord `*levelroles set <palier> <rôle>`.",
      );
      return;
    }

    await interaction.editReply(
      [
        `✅ Synchronisation terminée pour **${guild.name}**.`,
        `• Membres analysés : **${result.membersAnalyzed}**`,
        `• Rôles ajoutés : **${result.rolesAdded}**`,
        `• Rôles retirés : **${result.rolesRemoved}**`,
        result.errors > 0
          ? `• Erreurs d’attribution : **${result.errors}** (vérifie mes permissions et la position des rôles).`
          : "• Aucune erreur d’attribution.",
      ].join("\n"),
    );
    return;
  }

  const tier = interaction.options.getInteger("tier", true);
  const nextSettings = cloneGuildSettings(settings);
  const previousRoleId = settings.levelTierRoleIds[tier] ?? null;

  if (subcommand === "remove") {
    nextSettings.levelTierRoleIds[tier] = null;
    await saveGuildSettings(guild.id, nextSettings);
    await removeLevelTierRoleFromMembers(
      guild,
      previousRoleId,
      "Configuration du rôle de niveau retirée",
      false,
    );
    await reconcileGuildLevelTierRoles(guild, false);
    await interaction.reply({
      content: `✅ Le rôle du palier ${tier} (${tier === 1 ? "niveaux 1-9" : tier === MAX_LEVEL_TIERS ? "niveau 190+" : `niveaux ${(tier - 1) * LEVEL_TIER_SIZE}-${tier * LEVEL_TIER_SIZE - 1}`}) a été retiré.`,
      ephemeral: true,
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const botMember = guild.members.me;
  if (role.managed || (botMember && role.position >= botMember.roles.highest.position)) {
    await interaction.reply({
      content:
        "Je ne peux pas attribuer ce rôle : il est géré par une intégration ou placé au-dessus de mon rôle le plus élevé.",
      ephemeral: true,
    });
    return;
  }

  nextSettings.levelTierRoleIds[tier] = role.id;
  await saveGuildSettings(guild.id, nextSettings);
  if (previousRoleId && previousRoleId !== role.id) {
    await removeLevelTierRoleFromMembers(
      guild,
      previousRoleId,
      "Remplacement d’un rôle de niveau",
      false,
    );
  }
  await reconcileGuildLevelTierRoles(guild, false);

  await interaction.reply({
    content: `✅ ${role} est maintenant attribué au palier ${tier} (${tier === 1 ? "niveaux 1-9" : tier === MAX_LEVEL_TIERS ? "niveau 190+" : `niveaux ${(tier - 1) * LEVEL_TIER_SIZE}-${tier * LEVEL_TIER_SIZE - 1}`}) sur **${guild.name}**. Les membres actuellement en cache ont été synchronisés ; utilise \`*levelroles sync\` pour analyser toute la guilde.`,
    ephemeral: true,
  });
}

const ADMIN_COMMANDS = new Set([
  "say",
  "serverconfig",
  "levelroles",
  "resetsanctions",
  "set-xp",
  "add-xp",
  "remove-xp",
  "dropxp",
]);

const DISABLED_ANIMATION_COMMANDS = new Set([
  "announce",
  "poll",
  "firstreact",
  "guessnumber",
  "quickmath",
  "roulette",
  "tirage",
  "riddle",
  "scramble",
  "countdown",
  "truthordare",
  "wouldyourather",
  "hotseat",
]);

// ID Discord du propriétaire du bot. Les commandes listées dans
// OWNER_COMMANDS ne sont exécutables que par cet utilisateur, même par un
// Administrateur du serveur. Ajoute simplement le nom de la commande dans
// cet ensemble pour la réserver au propriétaire.
const BOT_OWNER_ID = "786986739650002975";
const OWNER_COMMANDS = new Set<string>([
  "backup",
  "resetsanctions",
  "resetmuteban",
  "say",
  "forceleaderboard",
  "resetlevels",
  "resetmember",
  "owner",
]);
const STRICT_OWNER_COMMANDS = new Set([
  "backup",
  "say",
  "forceleaderboard",
  "resetlevels",
  "resetmember",
  "owner",
  "maintenance",
]);

const OWNER_CATEGORY_SELECT_ID = "owner_category_select";
const OWNER_HOME_BUTTON_ID = "owner_home";
const OWNER_ANNOUNCEMENT_BUTTON_ID = "owner_announcement";
const OWNER_LOOKUP_BUTTON_ID = "owner_lookup";
const OWNER_ANNOUNCEMENT_CHANNEL_SELECT_ID = "owner_announcement_channel";
const OWNER_ANNOUNCEMENT_MODAL_PREFIX = "owner_announcement_modal_";
const OWNER_LOOKUP_USER_SELECT_ID = "owner_lookup_user";
const OWNER_MENU_GROUPS: Record<string, { label: string; description: string; commands: string[] }> = {
  information: {
    label: "Informations",
    description: "Informations serveur et commandes publiques.",
    commands: ["*ping", "*server", "*help", "*rank", "*leaderboard"],
  },
  moderation: {
    label: "Modération",
    description: "Sanctions, verrouillage et gestion des messages.",
    commands: [
      "*kick",
      "*ban",
      "*unban",
      "*mute",
      "*demute",
      "*warn",
      "*unwarn",
      "*clearmember",
      "*lock",
      "*unlock",
      "*sanctions",
      "*editsanction",
      "*resetsanctions",
      "*resetmuteban",
    ],
  },
  levels: {
    label: "Niveaux",
    description: "XP, niveaux et classements.",
    commands: [
      "*rank",
      "*leaderboard",
      "*levelroles status|set|remove|sync",
      "*set-xp",
      "*add-xp",
      "*remove-xp",
      "*forceleaderboard",
    ],
  },
    community: {
      label: "Communauté",
      description: "Rôles temporaires, absences et jeux.",
      commands: [
      "*customrole menu|list",
      "*abs add|edit",
      "*8ball",
      "*dice",
      "*joke",
    ],
  },
  owner: {
    label: "Propriétaire",
    description: "Fonctions réservées au propriétaire du bot.",
    commands: ["/owner announcement", "/owner lookup", "*forceleaderboard", "/say"],
  },
};

// Rôles "staff bot" : leurs détenteurs ont accès à TOUTES les commandes,
// exactement comme BOT_OWNER_ID, sans jamais avoir besoin d'être
// Administrateur du serveur ni d'avoir le rôle spécifique de la commande.
// Pratique pour ton équipe de dev/support sans distribuer la permission
// Administrateur Discord. Ajoute simplement les IDs de rôle voulus dans
// DISCORD_BOT_OWNER_ROLE_IDS (séparés par des virgules) pour les activer.
const BOT_OWNER_ROLE_IDS = (process.env.DISCORD_BOT_OWNER_ROLE_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

  // Vrai si l'auteur de l'interaction est le propriétaire du bot (BOT_OWNER_ID)
  // ou détient un des rôles "staff bot" (BOT_OWNER_ROLE_IDS). Utilisé partout
  // où un accès élevé est nécessaire : commandes et boutons/menus.
async function isBotOwnerInteraction(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<boolean> {
  if (interaction.user.id === BOT_OWNER_ID) {
    return true;
  }

  if (BOT_OWNER_ROLE_IDS.length === 0) {
    return false;
  }

  const member = await interaction.guild?.members
    .fetch(interaction.user.id)
    .catch(() => null);

  return Boolean(
    member &&
      BOT_OWNER_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId)),
  );
}

function isStrictBotOwnerInteraction(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ChannelSelectMenuInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
): boolean {
  return interaction.user.id === BOT_OWNER_ID;
}

// Revérifie l'accès à /customrole pour les interactions de composants (menu,
// modal) qui n'ont pas transité par le contrôle de permission fait pour la
// commande slash elle-même.
async function hasCustomRoleAccess(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (await isBotOwnerInteraction(interaction)) {
    return true;
  }

  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const settings = interaction.guild
    ? await getGuildSettings(interaction.guild.id)
    : emptyGuildSettings();
  const requiredRoleId = settings.roleIds.customrole;

  if (!requiredRoleId) {
    return false;
  }

  const member = await interaction.guild?.members
    .fetch(interaction.user.id)
    .catch(() => null);

  return Boolean(member?.roles.cache.has(requiredRoleId));
}

const commands = [
  new SlashCommandBuilder()
    .setName("server")
    .setDescription("Affiche les informations du serveur.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Affiche toutes les commandes par catégorie.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulse un membre du serveur.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre à expulser.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison de l'expulsion."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription(
      "Ban un membre du serveur (fonctionne aussi pour un ID qui n'est plus/pas sur le serveur).",
    )
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription(
          "Le membre à bannir (ID accepté même s'il n'est pas/plus sur le serveur).",
        )
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du bannissement."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannit un membre du serveur.")
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("L'identifiant Discord du membre à débannir.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du débannissement."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute un membre.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre à mute.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Durée du mute, entre 1 minute et 28 jours.")
        .setMinValue(1)
        .setMaxValue(40320)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du mute."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("demute")
    .setDescription("Retire le timeout d'un membre.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre à demute.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du demute."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription(
      "Verrouille le salon : seuls les rôles de modération peuvent y écrire.",
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du verrouillage."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Déverrouille le salon.")
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison du déverrouillage."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Supprime les messages récents du salon actuel.")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Nombre de messages à supprimer, entre 1 et 100.")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("clearmember")
    .setDescription("Supprime les messages récents d'un membre dans le salon actuel.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre dont les messages doivent être supprimés.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Nombre de messages à supprimer, entre 1 et 100.")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("security")
    .setDescription("Consulte et contrôle la sécurité du serveur.")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Affiche l'état de la sécurité."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("lockdown")
        .setDescription("Active le verrouillage de sécurité du serveur."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlock")
        .setDescription("Désactive le verrouillage de sécurité."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("inspect")
        .setDescription("Inspecte les indicateurs anti-spam, anti-raid et anti-nuke.")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Membre à inspecter, ou vide pour voir les membres suivis.")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Active ou désactive une protection.")
        .addStringOption((option) =>
          option
            .setName("feature")
            .setDescription("Protection à modifier.")
            .setRequired(true)
            .addChoices(
              { name: "Anti-spam", value: "antispam" },
              { name: "Anti-raid", value: "antiraid" },
               { name: "Anti-nuke", value: "antinuke" },
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Activer ou désactiver.")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("threshold")
            .setDescription(
              "Seuil anti-spam uniquement : 10-15 messages. L’anti-nuke est fixe à 3 actions en 5 secondes.",
            )
            .setMinValue(MIN_SPAM_THRESHOLD)
            .setMaxValue(MAX_SPAM_THRESHOLD),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Sauvegarde et restauration des données du bot.")
    .addSubcommand((sub) =>
      sub.setName("create").setDescription("Crée une sauvegarde complète."),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("Liste les sauvegardes disponibles."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("restore")
        .setDescription("Restaure une sauvegarde.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID de la sauvegarde.").setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName("confirm")
            .setDescription("Confirme le remplacement des données.")
            .setRequired(true),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("badge")
    .setDescription("Consulte les badges et le profil Cosmo.")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("Affiche les badges d'un membre.")
        .addUserOption((option) =>
          option.setName("user").setDescription("Membre à consulter."),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Consulte et complète ton profil membre.")
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("Affiche un profil membre.")
        .addUserOption((option) =>
          option.setName("user").setDescription("Membre à consulter."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Met à jour ton profil.")
        .addStringOption((option) =>
          option.setName("bio").setDescription("Ta présentation.").setMaxLength(500),
        )
        .addStringOption((option) =>
          option.setName("favorite_game").setDescription("Ton jeu préféré.").setMaxLength(80),
        )
        .addStringOption((option) =>
          option.setName("timezone").setDescription("Ton fuseau horaire.").setMaxLength(80),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Avertit un membre du serveur.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre à avertir.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("La raison de l'avertissement.")
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Annule un avertissement donné à un membre.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre dont l'avertissement doit être annulé.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("La raison de l'annulation."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("sanctions")
    .setDescription("Liste les sanctions du serveur (10 par page).")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Filtrer par type de sanction.")
        .addChoices(
          { name: "Warn", value: "warn" },
          { name: "Mute", value: "mute" },
          { name: "Kick", value: "kick" },
          { name: "Ban", value: "ban" },
        ),
    )
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription(
          "Filtrer par membre (inclut aussi unwarn, demute et unban).",
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Active ou désactive le mode maintenance global du bot.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("État du mode maintenance.")
        .setRequired(true)
        .addChoices(
          { name: "Activer", value: "on" },
          { name: "Désactiver", value: "off" },
          { name: "Afficher le statut", value: "status" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("serverconfig")
    .setDescription("Configure les salons et rôles de ce serveur.")
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Affiche la configuration du serveur."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Modifie une valeur de configuration.")
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("Clé, par exemple channel.autoReact ou role.warn.")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("ID Discord, texte ou none pour effacer.")
            .setRequired(true)
            .setMaxLength(2000),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("levelroles")
    .setDescription("Configure les rôles attribués selon les paliers de niveau.")
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Affiche les rôles configurés pour chaque palier."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Associe un rôle à une tranche de niveaux.")
        .addIntegerOption((option) =>
          option
            .setName("tier")
            .setDescription("1 = niveaux 1-9, 2 = niveaux 10-19, ... 20 = niveau 190+.")
            .setMinValue(1)
            .setMaxValue(MAX_LEVEL_TIERS)
            .setRequired(true),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Rôle à attribuer.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Retire la configuration d’un palier.")
        .addIntegerOption((option) =>
          option
            .setName("tier")
            .setDescription("Numéro du palier à effacer.")
            .setMinValue(1)
            .setMaxValue(MAX_LEVEL_TIERS)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("sync")
        .setDescription(
          "Analyse tous les membres et synchronise leurs rôles de niveau.",
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("editsanction")
    .setDescription("Modifie une sanction existante (durée et/ou raison).")
    .addIntegerOption((option) =>
      option
        .setName("id")
        .setDescription("Identifiant de la sanction, visible via /sanctions.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription(
          "Nouvelle durée en minutes, entre 1 minute et 28 jours (mute uniquement).",
        )
        .setMinValue(1)
        .setMaxValue(40320),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Nouvelle raison de la sanction."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetsanctions")
    .setDescription(
      "Réinitialise (supprime) toutes les sanctions warn/mute/ban du serveur.",
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Confirme la réinitialisation (action irréversible).")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetmuteban")
    .setDescription(
      "Réinitialise (supprime) uniquement les sanctions mute/ban du serveur.",
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Confirme la réinitialisation (action irréversible).")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("customrole")
    .setDescription("Gère les rôles personnalisés temporaires.")
    .addSubcommand((sub) =>
      sub
        .setName("menu")
        .setDescription(
          "Ouvre le menu pour créer ou retirer un rôle personnalisé.",
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("Liste les rôles personnalisés actifs."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("signaler")
    .setDescription("Signale un problème à l'équipe de modération.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre concerné.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("La catégorie du signalement.")
        .setRequired(true)
        .addChoices(
          { name: "Spam", value: "spam" },
          { name: "Insultes / harcèlement", value: "harassment" },
          { name: "Contenu inapproprié", value: "inappropriate" },
          { name: "Publicité", value: "advertising" },
          { name: "Comportement suspect", value: "suspicious" },
          { name: "Autre", value: "other" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("Décris précisément la situation.")
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption((option) =>
      option
        .setName("evidence")
        .setDescription("Lien vers un message ou une preuve (optionnel).")
        .setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("signalements")
    .setDescription("Consulte les signalements du serveur (modération).")
    .addStringOption((option) =>
      option
        .setName("status")
        .setDescription("Filtrer par statut.")
        .addChoices(
          { name: "Nouveaux", value: "new" },
          { name: "En cours", value: "in_progress" },
          { name: "En attente", value: "waiting" },
          { name: "Résolus", value: "resolved" },
          { name: "Rejetés", value: "rejected" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("priority")
        .setDescription("Filtrer par priorité.")
        .addChoices(
          { name: "Faible", value: "low" },
          { name: "Normale", value: "normal" },
          { name: "Haute", value: "high" },
          { name: "Critique", value: "critical" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("signalement")
    .setDescription("Traite un signalement (modération).")
    .addSubcommand((sub) =>
      sub
        .setName("voir")
        .setDescription("Consulte le détail et les notes d'un signalement.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("prendre")
        .setDescription("Prend en charge un signalement.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("note")
        .setDescription("Ajoute une note interne.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("content")
            .setDescription("La note interne.")
            .setRequired(true)
            .setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("priorite")
        .setDescription("Modifie la priorité.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("priority")
            .setDescription("Nouvelle priorité.")
            .setRequired(true)
            .addChoices(
              { name: "Faible", value: "low" },
              { name: "Normale", value: "normal" },
              { name: "Haute", value: "high" },
              { name: "Critique", value: "critical" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("statut")
        .setDescription("Modifie le statut.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Nouveau statut.")
            .setRequired(true)
            .addChoices(
              { name: "Nouveau", value: "new" },
              { name: "En cours", value: "in_progress" },
              { name: "En attente", value: "waiting" },
              { name: "Résolu", value: "resolved" },
              { name: "Rejeté", value: "rejected" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("fermer")
        .setDescription("Ferme définitivement un signalement.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID du signalement.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Raison de la clôture.")
            .setRequired(true)
            .setMaxLength(500),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("missions")
    .setDescription("Consulte et rejoint les missions communautaires.")
    .addSubcommand((sub) =>
      sub.setName("liste").setDescription("Affiche les missions actives."),
    )
    .addSubcommand((sub) =>
      sub.setName("progression").setDescription("Affiche ta progression."),
    )
    .addSubcommand((sub) =>
      sub.setName("classement").setDescription("Affiche le classement des missions."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("mission")
    .setDescription("Consulte le détail d'une mission communautaire.")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("ID de la mission.").setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("cosmo")
    .setDescription("Gère le système Cosmo Shield et Cosmo Missions.")
    .addSubcommand((sub) =>
      sub.setName("setup").setDescription("Crée les salons et rôles Cosmo."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mission-create")
        .setDescription("Crée une mission communautaire.")
        .addStringOption((option) =>
          option.setName("title").setDescription("Titre de la mission.").setRequired(true).setMaxLength(100),
        )
        .addStringOption((option) =>
          option.setName("description").setDescription("Description de la mission.").setRequired(true).setMaxLength(500),
        )
        .addIntegerOption((option) =>
          option.setName("days").setDescription("Durée en jours.").setMinValue(1).setMaxValue(30),
        )
        .addIntegerOption((option) =>
          option.setName("target").setDescription("Objectif par membre.").setMinValue(1).setMaxValue(1000),
        )
        .addIntegerOption((option) =>
          option.setName("reward_xp").setDescription("XP à gagner à la validation.").setMinValue(0).setMaxValue(10000),
        )
        .addStringOption((option) =>
          option
            .setName("trigger")
            .setDescription("Événement qui fait progresser automatiquement la mission.")
            .addChoices(
              { name: "Manuel", value: "manual" },
              { name: "Message", value: "message" },
              { name: "Nouveau membre", value: "join" },
              { name: "Signalement Cosmo", value: "report" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mission-close")
        .setDescription("Ferme une mission active.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID de la mission.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mission-validate")
        .setDescription("Valide la progression d'un membre.")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("ID de la mission.").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("Membre à valider.").setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName("progress").setDescription("Nouvelle progression.").setRequired(true).setMinValue(1).setMaxValue(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mission-publish")
        .setDescription("Force la publication immédiate des missions globales."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("firstreact")
    .setDescription("Le premier membre à réagir gagne (animateurs).")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Le message à afficher.")
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes (60 par défaut).")
        .setMinValue(5)
        .setMaxValue(300),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("guessnumber")
    .setDescription('Lance un jeu "devine le nombre" (animateurs).')
    .addIntegerOption((option) =>
      option.setName("min").setDescription("Borne minimale.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("max").setDescription("Borne maximale.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes (60 par défaut).")
        .setMinValue(10)
        .setMaxValue(600),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("quickmath")
    .setDescription("Lance un défi de calcul mental (animateurs).")
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes (30 par défaut).")
        .setMinValue(10)
        .setMaxValue(300),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("roulette")
    .setDescription("Fait tourner une roulette de casino, pour l'ambiance (animateurs).")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("tirage")
    .setDescription(
      "Tirage au sort éclair : les membres réagissent, un gagnant est tiré au sort (animateurs).",
    )
    .addStringOption((option) =>
      option
        .setName("prize")
        .setDescription("Ce que le gagnant remporte / l'objet du tirage.")
        .setRequired(true)
        .setMaxLength(200),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes pour réagir (30 par défaut).")
        .setMinValue(5)
        .setMaxValue(300),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("riddle")
    .setDescription("Lance une devinette de ton choix (animateurs).")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("La question à poser.")
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption((option) =>
      option
        .setName("answer")
        .setDescription("La bonne réponse (insensible à la casse et aux accents).")
        .setRequired(true)
        .setMaxLength(200),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes (60 par défaut).")
        .setMinValue(10)
        .setMaxValue(600),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("scramble")
    .setDescription("Devine le mot mélangé (animateurs).")
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en secondes (60 par défaut).")
        .setMinValue(10)
        .setMaxValue(600),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("countdown")
    .setDescription("Lance un compte à rebours visuel pour démarrer une activité (animateurs).")
    .addStringOption((option) =>
      option
        .setName("label")
        .setDescription("Nom de l'activité qui va démarrer.")
        .setRequired(true)
        .setMaxLength(100),
    )
    .addRoleOption((option) =>
      option
        .setName("ping_role")
        .setDescription("Rôle à pinguer au lancement du compte à rebours."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("truthordare")
    .setDescription("Action ou vérité (animateurs).")
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Vérité ou action (aléatoire si non précisé).")
        .addChoices(
          { name: "Vérité", value: "truth" },
          { name: "Action", value: "dare" },
        ),
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Le membre visé (optionnel)."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("wouldyourather")
    .setDescription('Duel "tu préfères" A ou B (animateurs).')
    .addStringOption((option) =>
      option.setName("option_a").setDescription("Option A.").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("option_b").setDescription("Option B.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Durée en minutes avant la révélation des résultats (2 par défaut).")
        .setMinValue(1)
        .setMaxValue(1440),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("hotseat")
    .setDescription(
      "Désigne au hasard un membre du salon vocal pour être sous le feu des projecteurs (animateurs).",
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("dropxp")
    .setDescription(
      "Lâche un drop d'XP : le premier à réagir au message le remporte (Administrateur).",
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Quantité d'XP à faire gagner.")
        .setRequired(true)
        .setMinValue(1),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("abs")
    .setDescription("Gère les déclarations d'absence.")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Déclare une absence.")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Le membre absent.")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("Durée de l'absence.")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Raison de l'absence.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Modifie une absence déjà déclarée.")
        .addStringOption((option) =>
          option
            .setName("message_id")
            .setDescription("L'identifiant du message de l'absence.")
            .setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("member").setDescription("Nouveau membre concerné."),
        )
        .addStringOption((option) =>
          option.setName("duration").setDescription("Nouvelle durée."),
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("Nouvelle raison."),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Affiche ton niveau et ton XP (ou ceux d'un autre membre).")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Le membre à consulter (toi par défaut)."),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Affiche le classement des membres par XP.")
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("Nombre de membres à afficher (10 par défaut, 25 max).")
        .setMinValue(1)
        .setMaxValue(25),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Pose une question à la boule magique.")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Ta question.")
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Lance un ou plusieurs dés.")
    .addIntegerOption((option) =>
      option
        .setName("sides")
        .setDescription("Nombre de faces du dé (6 par défaut).")
        .setMinValue(2)
        .setMaxValue(1000),
    )
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Nombre de dés à lancer (1 par défaut, 20 max).")
        .setMinValue(1)
        .setMaxValue(20),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("joke")
    .setDescription("Raconte une blague au hasard.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("set-xp")
    .setDescription("Définit le niveau ou l'XP total d'un membre.")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Le membre concerné.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription("Niveau cible (à utiliser SANS l'option xp).")
        .setMinValue(0),
    )
    .addIntegerOption((option) =>
      option
        .setName("xp")
        .setDescription("XP total cible (à utiliser SANS l'option level).")
        .setMinValue(0),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Raison de la modification."),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("add-xp")
    .setDescription("Ajoute des niveaux ou de l'XP à un membre.")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Le membre concerné.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription(
          "Nombre de niveaux à ajouter (à utiliser SANS l'option xp).",
        )
        .setMinValue(1),
    )
    .addIntegerOption((option) =>
      option
        .setName("xp")
        .setDescription(
          "Nombre d'XP à ajouter (à utiliser SANS l'option level).",
        )
        .setMinValue(1),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Raison de la modification."),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("remove-xp")
    .setDescription("Retire des niveaux ou de l'XP à un membre.")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Le membre concerné.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription(
          "Nombre de niveaux à retirer (à utiliser SANS l'option xp).",
        )
        .setMinValue(1),
    )
    .addIntegerOption((option) =>
      option
        .setName("xp")
        .setDescription(
          "Nombre d'XP à retirer (à utiliser SANS l'option level).",
        )
        .setMinValue(1),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Raison de la modification."),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("forceleaderboard")
    .setDescription(
      "Force l'affichage immédiat du classement mensuel (dépannage).",
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetlevels")
    .setDescription("Réinitialise les niveaux de tous les membres du serveur.")
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Confirme la suppression définitive de toute l'XP.")
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetmember")
    .setDescription("Réinitialise les données d'un membre (propriétaire uniquement).")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Le membre à réinitialiser.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reset")
        .setDescription("Le domaine à réinitialiser.")
        .setRequired(true)
        .addChoices(
          { name: "Niveau et XP", value: "niveau" },
          { name: "Sanctions", value: "sanctions" },
          { name: "Progression des missions", value: "missions" },
          { name: "Rôles personnalisés", value: "rolesperso" },
          { name: "Tout sauf les signalements", value: "all" },
        ),
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Confirme l'action irréversible.")
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("owner")
    .setDescription("Ouvre le panneau de contrôle du propriétaire du bot.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Envoie un message sous l'identité du bot.")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Le message à envoyer.")
        .setMaxLength(2000)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Le salon où envoyer le message.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
];

const enabledCommands = commands.filter(
  (command) => !DISABLED_ANIMATION_COMMANDS.has(command.name),
);

function registerCommandHandlers(client: DiscordClient<boolean>) {
  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      if (
        interaction.customId === OWNER_HOME_BUTTON_ID ||
        interaction.customId === OWNER_ANNOUNCEMENT_BUTTON_ID ||
        interaction.customId === OWNER_LOOKUP_BUTTON_ID
      ) {
        await handleOwnerButton(interaction).catch((err) => {
          logger.error({ err, customId: interaction.customId }, "Owner button handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(HELP_PAGE_BUTTON_PREFIX)) {
        await handleHelpPageButton(interaction).catch((err) => {
          logger.error({ err }, "Help pagination handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(SERVER_CONFIG_PAGE_BUTTON_PREFIX)) {
        await handleServerConfigPageButton(interaction).catch((err) => {
          logger.error({ err }, "Server config pagination handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(SANCTIONS_PAGE_BUTTON_PREFIX)) {
        await handleSanctionsPageButton(interaction).catch((err) => {
          logger.error({ err }, "Sanctions pagination handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(CNDRAW_JOIN_PREFIX)) {
        await handleColorNumberJoinButton(interaction).catch((err) => {
          logger.error({ err }, "Color/number draw join handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(COSMO_MISSION_JOIN_PREFIX)) {
        await handleCosmoMissionJoinButton(interaction).catch((err) => {
          logger.error({ err }, "Cosmo mission join handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(COSMO_REPORT_BUTTON_PREFIX)) {
        await handleCosmoReportButton(interaction).catch((err) => {
          logger.error({ err }, "Cosmo report button handling failed");
        });
      }
      return;
    }

    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === OWNER_ANNOUNCEMENT_CHANNEL_SELECT_ID) {
        await handleOwnerAnnouncementChannelSelect(interaction).catch((err) => {
          logger.error({ err }, "Owner announcement channel handling failed");
        });
      }
      return;
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === OWNER_LOOKUP_USER_SELECT_ID) {
        await handleOwnerLookupUserSelect(interaction).catch((err) => {
          logger.error({ err }, "Owner lookup handling failed");
        });
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === OWNER_CATEGORY_SELECT_ID) {
        await handleOwnerCategorySelect(interaction).catch((err) => {
          logger.error({ err }, "Owner category handling failed");
        });
        return;
      }

      if (interaction.customId === CUSTOMROLE_MENU_SELECT_ID) {
        await handleCustomRoleMenuSelect(interaction).catch((err) => {
          logger.error({ err }, "Customrole menu select handling failed");
        });
        return;
      }

      if (interaction.customId === CUSTOMROLE_REMOVE_SELECT_ID) {
        await handleCustomRoleRemoveSelect(interaction).catch((err) => {
          logger.error({ err }, "Customrole remove select handling failed");
        });
        return;
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(OWNER_ANNOUNCEMENT_MODAL_PREFIX)) {
        await handleOwnerAnnouncementModal(interaction).catch((err) => {
          logger.error({ err }, "Owner announcement modal handling failed");
        });
        return;
      }

      if (interaction.customId === CUSTOMROLE_CREATE_MODAL_ID) {
        await handleCustomRoleCreateModalSubmit(interaction).catch((err) => {
          logger.error({ err }, "Customrole create modal handling failed");
        });
        return;
      }

      if (interaction.customId.startsWith(CNDRAW_MODAL_PREFIX)) {
        await handleColorNumberBetModalSubmit(interaction).catch((err) => {
          logger.error({ err }, "Color/number bet modal handling failed");
        });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    await executeCommandWithGuards(interaction);
  });
}

async function executeCommandWithGuards(
  interaction: ChatInputCommandInteraction,
) {
  try {
    const commandPrefix =
      interaction instanceof PrefixCommandInteraction ? "*" : "/";
    const commandLabel = `${commandPrefix}${interaction.commandName}`;
    const isBotOwner = await isBotOwnerInteraction(interaction);

    if (
      STRICT_OWNER_COMMANDS.has(interaction.commandName) &&
      !isStrictBotOwnerInteraction(interaction)
    ) {
      await interaction.reply({
        content: "Cette commande est réservée au propriétaire principal du bot.",
        ephemeral: true,
      });
      return;
    }

    if (
      !isStrictBotOwnerInteraction(interaction) &&
      (await isBotMaintenanceEnabled())
    ) {
      await interaction.reply({
        content:
          "Le bot est actuellement en maintenance. Seul le propriétaire principal peut utiliser ses commandes.",
        ephemeral: true,
      });
      return;
    }

    if (!isBotOwner) {
      if (
        OWNER_COMMANDS.has(interaction.commandName) &&
        interaction.user.id !== BOT_OWNER_ID
      ) {
        await interaction.reply({
          content: "Cette commande est réservée au propriétaire du bot.",
          ephemeral: true,
        });
        return;
      }

      if (
        ADMIN_COMMANDS.has(interaction.commandName) &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ) {
        await interaction.reply(
          "Cette commande est réservée aux membres ayant la permission Administrateur.",
        );
        return;
      }

      const isAdmin = interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      );
      const guildSettings = interaction.guild
        ? await getGuildSettings(interaction.guild.id)
        : emptyGuildSettings();
      const configuredRoleIds = getGuildRoleIds(guildSettings);
      const anyRoleIds =
        interaction.commandName === "editsanction"
          ? [configuredRoleIds.ban, configuredRoleIds.mute].filter(
              (roleId): roleId is string => Boolean(roleId),
            )
          : undefined;

      if (anyRoleIds !== undefined && !isAdmin) {
        if (anyRoleIds.length === 0) {
          await interaction.reply(
            `Aucun rôle n’est configuré pour ${commandLabel}. Contacte l’administrateur du bot.`,
          );
          return;
        }

        const member = await interaction.guild?.members
          .fetch(interaction.user.id)
          .catch(() => null);

        if (!anyRoleIds.some((roleId) => member?.roles.cache.has(roleId))) {
          await interaction.reply(
              `Cette commande est réservée aux membres ayant l’un des rôles requis pour ${commandLabel}.`,
          );
          return;
        }

        await handleCommand(interaction);
        await deletePrefixSourceMessage(interaction);
        return;
      }

      const roleKeyByCommand: Record<string, string> = {
        warn: "warn",
        unwarn: "warn",
        mute: "mute",
        demute: "demute",
        kick: "kick",
        ban: "ban",
        unban: "unban",
        lock: "lock",
        unlock: "unlock",
        customrole: "customrole",
        helpstaff: "warn",
        abs: "warn",
        clear: "clear",
        clearmember: "clear",
        sanctions: "warn",
        rank: "members",
      };
      const roleKey = roleKeyByCommand[interaction.commandName];
      const requiredRoleId =
        roleKey === undefined ? undefined : configuredRoleIds[roleKey] ?? null;

      if (requiredRoleId !== undefined && !isAdmin) {
        if (!requiredRoleId) {
          await interaction.reply(
            `Le rôle requis pour ${commandLabel} n’est pas configuré. Contacte l’administrateur du bot.`,
          );
          return;
        }

        const member = await interaction.guild?.members
          .fetch(interaction.user.id)
          .catch(() => null);

        if (!member?.roles.cache.has(requiredRoleId)) {
          await interaction.reply(
            `Cette commande est réservée aux membres ayant le rôle requis pour ${commandLabel}.`,
          );
          return;
        }
      }
    }

    await handleCommand(interaction);
    await deletePrefixSourceMessage(interaction);
  } catch (err) {
    logger.error(
      { err, command: interaction.commandName },
      "Discord command failed",
    );

    const response = {
      content: "Une erreur est survenue pendant l’exécution de la commande.",
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  switch (interaction.commandName) {
    case "server": {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Cette commande doit être utilisée dans un serveur.",
        });
        return;
      }

      await interaction.deferReply();
      await interaction.editReply({
        embeds: [await buildServerInfoEmbed(interaction.guild)],
      });
      return;
    }
    case "owner":
      await ownerCommand(interaction);
      return;
    case "signaler":
      await handleCosmoReportCommand(interaction);
      return;
    case "signalements":
      await handleCosmoReportsCommand(interaction);
      return;
    case "signalement":
      await handleCosmoReportActionCommand(interaction);
      return;
    case "missions":
      await handleCosmoMissionsCommand(interaction);
      return;
    case "mission":
      await handleCosmoMissionCommand(interaction);
      return;
    case "cosmo":
      await handleCosmoAdminCommand(interaction);
      return;
    case "help":
      await interaction.reply(buildHelpPage(0));
      return;
    case "kick":
      await moderateMember(interaction, {
        permission: PermissionFlagsBits.KickMembers,
        reason:
          interaction.options.getString("reason") ?? "Aucune raison fournie.",
      });
      return;
    case "ban":
      await banMember(interaction);
      return;
    case "unban":
      await unbanMember(interaction);
      return;
    case "mute":
      await timeoutMember(interaction);
      return;
    case "demute":
      await unmuteMember(interaction);
      return;
    case "lock":
      await lockChannel(interaction);
      return;
    case "unlock":
      await unlockChannel(interaction);
      return;
    case "clearmember":
      await clearMemberMessages(interaction);
      return;
    case "clear":
      await clearMessages(interaction);
      return;
    case "security":
      await handleSecurityCommand(interaction);
      return;
    case "backup":
      await handleBackupCommand(interaction);
      return;
    case "badge":
      await handleBadgeCommand(interaction);
      return;
    case "profile":
      await handleProfileCommand(interaction);
      return;
    case "warn":
      await warnMember(interaction);
      return;
    case "unwarn":
      await unwarnMember(interaction);
      return;
    case "sanctions":
      await listSanctions(interaction);
      return;
    case "maintenance":
      await handleMaintenanceCommand(interaction);
      return;
    case "serverconfig":
      await handleServerConfigCommand(interaction);
      return;
    case "levelroles":
      await handleLevelRolesCommand(interaction);
      return;
    case "editsanction":
      await editSanction(interaction);
      return;
    case "resetsanctions":
      await resetSanctions(interaction);
      return;
    case "resetmuteban":
      await resetMuteBanSanctions(interaction);
      return;
    case "forceleaderboard":
      await forceLeaderboardCommand(interaction);
      return;
    case "resetlevels":
      await resetLevelsCommand(interaction);
      return;
    case "resetmember":
      await resetMemberCommand(interaction);
      return;
    case "customrole":
      await handleCustomRoleCommand(interaction);
      return;
    case "announce":
      await handleAnnounceCommand(interaction);
      return;
    case "poll":
      await handlePollCommand(interaction);
      return;
    case "firstreact":
      await handleFirstReactCommand(interaction);
      return;
    case "guessnumber":
      await handleGuessNumberCommand(interaction);
      return;
    case "quickmath":
      await handleQuickMathCommand(interaction);
      return;
    case "roulette":
      await handleRouletteCommand(interaction);
      return;
    case "tirage":
      await handleTirageCommand(interaction);
      return;
    case "riddle":
      await handleRiddleCommand(interaction);
      return;
    case "scramble":
      await handleScrambleCommand(interaction);
      return;
    case "countdown":
      await handleCountdownCommand(interaction);
      return;
    case "truthordare":
      await handleTruthOrDareCommand(interaction);
      return;
    case "wouldyourather":
      await handleWouldYouRatherCommand(interaction);
      return;
    case "hotseat":
      await handleHotSeatCommand(interaction);
      return;
    case "dropxp":
      await handleDropXpCommand(interaction);
      return;
    case "abs":
      await handleAbsenceCommand(interaction);
      return;
    case "rank":
      await rankCommand(interaction);
      return;
    case "leaderboard":
      await leaderboardCommand(interaction);
      return;
    case "8ball":
      await handleEightBall(interaction);
      return;
    case "dice":
      await handleDice(interaction);
      return;
    case "joke":
      await handleJoke(interaction);
      return;
    case "set-xp":
      await setXpCommand(interaction);
      return;
    case "add-xp":
      await addXpCommand(interaction);
      return;
    case "remove-xp":
      await removeXpCommand(interaction);
      return;
    case "say":
      await sendAsBot(interaction);
      return;
    default:
      await interaction.reply({
        content: "Commande inconnue.",
      });
  }
}

async function handleHelpPageButton(interaction: ButtonInteraction) {
  const suffix = interaction.customId.slice(HELP_PAGE_BUTTON_PREFIX.length);
  const actionPageMatch = suffix.match(/^(?:home|previous|next)_(-?\d+)$/);
  const rawPage = Number.parseInt(
    actionPageMatch?.[1] ?? suffix,
    10,
  );
  const page = normalizeHelpPage(
    Number.isInteger(rawPage) ? rawPage : 0,
  );

  try {
    const helpPage = buildHelpPage(page);
    await interaction.update({
      embeds: helpPage.embeds,
      components: helpPage.components,
    });
  } catch (err) {
    logger.error(
      { err, customId: interaction.customId, page, userId: interaction.user.id },
      "Help pagination update failed",
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content:
            "Impossible de changer de page pour le moment. Relance `*help` et réessaie.",
          ephemeral: true,
        })
        .catch((replyError) => {
          logger.error({ err: replyError }, "Failed to report help pagination error");
        });
    }
  }
}

async function handleServerConfigPageButton(interaction: ButtonInteraction) {
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) &&
    !(await isBotOwnerInteraction(interaction))
  ) {
    await interaction.reply({
      content:
        "Cette action est réservée aux membres ayant la permission Administrateur.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette action doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const suffix = interaction.customId.slice(
    SERVER_CONFIG_PAGE_BUTTON_PREFIX.length,
  );
  const actionPageMatch = suffix.match(/^(?:home|previous|next)_(-?\d+)$/);
  const rawPage = Number.parseInt(
    actionPageMatch?.[1] ?? suffix,
    10,
  );
  const page = normalizeServerConfigPage(
    Number.isInteger(rawPage) ? rawPage : 0,
  );
  const settings = await getGuildSettings(guild.id);
  const status = buildServerConfigStatus(
    guild.name,
    SERVER_CONFIG_KEYS,
    (key) => getServerConfigValue(settings, key as ServerConfigKey),
    page,
  );

  await interaction.update({
    embeds: status.embeds,
    components: status.components,
  });
}

async function buildServerInfoEmbed(guild: Guild): Promise<EmbedBuilder> {
  await guild.members.fetch().catch((err) => {
    logger.error(
      { err, guildId: guild.id },
      "Failed to fetch all guild members for server information",
    );
  });

  const staffColumnFields = SERVER_STAFF_COLUMN_ROLE_IDS.map((roleId) => {
    const role = guild.roles.cache.get(roleId);
    const members = guild.members.cache.filter((member) =>
      member.roles.cache.has(roleId),
    );
    const memberList =
      members.size > 0
        ? Array.from(members.values())
            .map((member) => `<@${member.id}>`)
            .join("\n")
        : "Aucun membre";

    return {
      name: `${role ? role.name : "Rôle introuvable"} (${members.size})`,
      value: memberList.slice(0, 1024),
      inline: true,
    };
  });

  const lineCount = await getBotSourceLineCount();

  return new EmbedBuilder()
    .setTitle(`Informations — ${guild.name}`)
    .setColor(0x3498db)
    .addFields(
      { name: "Membres", value: String(guild.memberCount), inline: true },
      {
        name: "Créé le",
        value: guild.createdAt.toLocaleDateString("fr-FR"),
        inline: true,
      },
      { name: "ID du serveur", value: guild.id, inline: true },
      ...staffColumnFields,
      {
        name: "Code du bot",
        value:
          lineCount !== null
            ? `${lineCount} lignes`
            : "Indisponible",
        inline: true,
      },
    )
    .setTimestamp();
}

function buildOwnerHomeComponents() {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(OWNER_CATEGORY_SELECT_ID)
    .setPlaceholder("Choisir un groupe de fonctions")
    .addOptions(
      Object.entries(OWNER_MENU_GROUPS).map(([value, group]) => ({
        label: group.label,
        value,
        description: group.description,
      })),
    );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(OWNER_ANNOUNCEMENT_BUTTON_ID)
      .setLabel("Annonce globale")
      .setEmoji("📢")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(OWNER_LOOKUP_BUTTON_ID)
      .setLabel("Lookup utilisateur")
      .setEmoji("🔎")
      .setStyle(ButtonStyle.Secondary),
  );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(categoryMenu),
    actionRow,
  ];
}

function buildOwnerHomeEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Panneau propriétaire")
    .setColor(0x9b59b6)
    .setDescription(
      [
        "Utilise le menu pour consulter toutes les fonctions du bot, regroupées par catégorie.",
        "",
        "Les boutons ci-dessous ouvrent les fonctions réservées au propriétaire :",
        "📢 **Annonce globale** — choisit un salon puis diffuse le message dans les serveurs compatibles.",
        "🔎 **Lookup utilisateur** — affiche les informations Discord et l’historique des sanctions.",
      ].join("\n"),
    )
    .setFooter({ text: `Serveurs connectés : ${0}` })
    .setTimestamp();
}

function buildOwnerCategoryEmbed(category: string): EmbedBuilder {
  const group = OWNER_MENU_GROUPS[category] ?? OWNER_MENU_GROUPS.information;

  return new EmbedBuilder()
    .setTitle(`Panneau propriétaire — ${group.label}`)
    .setColor(0x9b59b6)
    .setDescription(
      [`**${group.description}**`, "", ...group.commands.map((command) => `• \`${command}\``)].join(
        "\n",
      ),
    )
    .setTimestamp();
}

async function ownerCommand(interaction: ChatInputCommandInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette commande est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  const embed = buildOwnerHomeEmbed().setFooter({
    text: `Serveurs connectés : ${interaction.client.guilds.cache.size}`,
  });

  await interaction.reply({
    embeds: [embed],
    components: buildOwnerHomeComponents(),
    ephemeral: true,
  });
}

async function handleOwnerButton(interaction: ButtonInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette fonction est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === OWNER_HOME_BUTTON_ID) {
    await interaction.update({
      embeds: [
        buildOwnerHomeEmbed().setFooter({
          text: `Serveurs connectés : ${interaction.client.guilds.cache.size}`,
        }),
      ],
      components: buildOwnerHomeComponents(),
    });
    return;
  }

  if (interaction.customId === OWNER_ANNOUNCEMENT_BUTTON_ID) {
    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId(OWNER_ANNOUNCEMENT_CHANNEL_SELECT_ID)
      .setPlaceholder("Choisir le salon modèle pour l'annonce")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Annonce globale")
          .setColor(0xe67e22)
          .setDescription(
            "Choisis un salon texte. Le message sera ensuite envoyé dans les salons portant le même nom sur tous les serveurs où le bot est présent.",
          ),
      ],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(OWNER_HOME_BUTTON_ID)
            .setLabel("Retour")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (interaction.customId === OWNER_LOOKUP_BUTTON_ID) {
    const userMenu = new UserSelectMenuBuilder()
      .setCustomId(OWNER_LOOKUP_USER_SELECT_ID)
      .setPlaceholder("Choisir un utilisateur à rechercher")
      .setMinValues(1)
      .setMaxValues(1);

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Lookup utilisateur")
          .setColor(0x3498db)
          .setDescription(
            "Choisis un membre dans ce serveur. Le bot recherchera ensuite ses informations et ses sanctions enregistrées.",
          ),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(OWNER_HOME_BUTTON_ID)
            .setLabel("Retour")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }
}

async function handleOwnerCategorySelect(interaction: StringSelectMenuInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette fonction est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    embeds: [buildOwnerCategoryEmbed(interaction.values[0] ?? "information")],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(OWNER_HOME_BUTTON_ID)
          .setLabel("Retour au menu")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

function buildOwnerAnnouncementModal(channelId: string) {
  return new ModalBuilder()
    .setCustomId(`${OWNER_ANNOUNCEMENT_MODAL_PREFIX}${channelId}`)
    .setTitle("Annonce globale")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("owner_announcement_message")
          .setLabel("Message à diffuser")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(2000)
          .setRequired(true),
      ),
    );
}

async function handleOwnerAnnouncementChannelSelect(
  interaction: ChannelSelectMenuInteraction,
) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette fonction est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  const channelId = interaction.values[0];
  if (!channelId) {
    await interaction.reply({
      content: "Aucun salon n'a été sélectionné.",
      ephemeral: true,
    });
    return;
  }

  await interaction.showModal(buildOwnerAnnouncementModal(channelId));
}

async function handleOwnerAnnouncementModal(interaction: ModalSubmitInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette fonction est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  const channelId = interaction.customId.slice(OWNER_ANNOUNCEMENT_MODAL_PREFIX.length);
  const sourceChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (
    !sourceChannel ||
    (sourceChannel.type !== ChannelType.GuildText &&
      sourceChannel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.reply({
      content: "Le salon sélectionné est introuvable ou n'est pas textuel.",
      ephemeral: true,
    });
    return;
  }

  const content = interaction.fields.getTextInputValue("owner_announcement_message");
  let sent = 0;
  let skipped = 0;

  for (const guild of interaction.client.guilds.cache.values()) {
    const targetChannel = guild.channels.cache.find(
      (channel) =>
        (channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement) &&
        channel.name === sourceChannel.name,
    ) as TextChannel | undefined;

    if (!targetChannel) {
      skipped++;
      continue;
    }

    const delivered = await targetChannel
      .send({ content, allowedMentions: { parse: [] } })
      .then(() => true)
      .catch((err) => {
        logger.error(
          { err, guildId: guild.id, channelName: sourceChannel.name },
          "Failed to send owner announcement",
        );
        return false;
      });

    if (delivered) sent++;
    else skipped++;
  }

  await interaction.reply({
    content: `Annonce envoyée dans **${sent}** serveur(s). **${skipped}** serveur(s) ignoré(s) (salon absent ou inaccessible).`,
    ephemeral: true,
  });
}

async function handleOwnerLookupUserSelect(interaction: UserSelectMenuInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette fonction est réservée au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.values[0];
  if (!userId) {
    await interaction.reply({
      content: "Aucun utilisateur n'a été sélectionné.",
      ephemeral: true,
    });
    return;
  }

  const user = await interaction.client.users.fetch(userId).catch(() => null);
  if (!user) {
    await interaction.reply({
      content: "Utilisateur introuvable.",
      ephemeral: true,
    });
    return;
  }

  const sanctions = await db
    .select()
    .from(discordSanctionsTable)
    .where(eq(discordSanctionsTable.targetId, userId))
    .orderBy(desc(discordSanctionsTable.createdAt))
    .limit(10);

  const memberships: string[] = [];
  for (const guild of interaction.client.guilds.cache.values()) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      memberships.push(`${guild.name} — ${member.displayName}`);
    }
  }

  const sanctionSummary =
    sanctions.length > 0
      ? sanctions
          .map(
            (sanction) =>
              `• **${sanction.action.toUpperCase()}** — ${sanction.reason} — ${formatDate(sanction.createdAt)}`,
          )
          .join("\n")
      : "Aucune sanction enregistrée.";

  const embed = new EmbedBuilder()
    .setTitle(`Lookup — ${user.tag}`)
    .setColor(0x3498db)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      {
        name: "Identité",
        value: [
          `**ID :** \`${user.id}\``,
          `**User :** ${user.username}`,
          `**Pseudo global :** ${user.globalName ?? "Aucun"}`,
          `**Tag :** ${user.tag}`,
        ].join("\n"),
      },
      {
        name: "Compte",
        value: [
          `**Créé le :** ${formatDate(user.createdAt)}`,
          `**Bot :** ${user.bot ? "Oui" : "Non"}`,
          `**Avatar :** [Ouvrir](${user.displayAvatarURL()})`,
        ].join("\n"),
      },
      {
        name: `Serveur(s) (${memberships.length})`,
        value: memberships.length > 0 ? memberships.join("\n").slice(0, 1024) : "Aucun serveur commun.",
      },
      {
        name: `Sanctions récentes (${sanctions.length})`,
        value: sanctionSummary.slice(0, 1024),
      },
    )
    .setTimestamp();

  await interaction.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(OWNER_HOME_BUTTON_ID)
          .setLabel("Retour au menu")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function canModerateTarget(
  interaction: ChatInputCommandInteraction,
  target: GuildMember,
) {
  const guild = interaction.guild;
  if (!guild) return false;
  const moderator = await guild.members.fetch(interaction.user.id);
  if (moderator.id === guild.ownerId) return true;
  if (target.id === guild.ownerId) return false;
  return moderator.roles.highest.position > target.roles.highest.position;
}

// Emoji ajouté au début des réponses des commandes de modération : succès
// (réutilise le même emoji que l'auto-react) ou échec (nouvel emoji dédié).
const FALSE_COMMAND_EMOJI_NAME =
  process.env.DISCORD_FALSE_COMMAND_EMOJI_NAME ?? "non";

function findGuildEmoji(guild: Guild, emojiName: string) {
  return guild.emojis.cache.find(
    (candidate) => candidate.name?.toLowerCase() === emojiName.toLowerCase(),
  );
}

// Retourne "<emoji> " (avec l'espace) si l'emoji custom est trouvé sur le
// serveur, sinon une chaîne vide (le message reste normal sans planter).
function moderationResultPrefix(
  guild: Guild | null | undefined,
  success: boolean,
): string {
  if (!guild) {
    return "";
  }

  const configuredEmojiName =
    guild && GUILD_SETTINGS_CACHE.get(guild.id)?.autoReactEmojiName;
  const emojiName = success
    ? configuredEmojiName
    : FALSE_COMMAND_EMOJI_NAME;
  const emoji = emojiName ? findGuildEmoji(guild, emojiName) : undefined;
  return emoji ? `${emoji} ` : "";
}

async function moderateMember(
  interaction: ChatInputCommandInteraction,
  options: {
    permission: bigint;
    reason: string;
  },
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(options.permission)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord nécessaire pour effectuer cette action.`,
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const target = await guild.members.fetch(user.id).catch(() => null);

  if (!target) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce membre ne fait pas partie de ce serveur.`,
    });
    return;
  }

  if (!(await canModerateTarget(interaction, target))) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
    });
    return;
  }

  if (!target.manageable || target.id === guild.ownerId) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je ne peux pas modérer ce membre : son rôle est supérieur au mien ou il s’agit du propriétaire.`,
    });
    return;
  }

  await target
    .send(
      `Tu as été expulsé de **${guild.name}**.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${options.reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
    )
    .catch(() => undefined);

  await target.kick(options.reason);
  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "kick",
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason: options.reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "kick",
    targetId: target.id,
    targetTag: target.user.tag,
    targetNickname: target.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason: options.reason,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}**${target.user.tag}** a été expulsé. Raison : ${options.reason}${formatSanctionIdSuffix(sanctionId)}`,
  });
}

async function banMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord nécessaire pour effectuer cette action.`,
    });
    return;
  }

  let user = interaction.options.getUser("user");
  if (!user && interaction instanceof PrefixCommandInteraction) {
    const referencedMessage = await interaction.fetchReferencedMessage();
    user = referencedMessage?.author ?? null;
  }

  if (!user) {
    await interaction.reply({
      content:
        `${moderationResultPrefix(guild, false)}Indique un membre avec \`*ban @membre raison\` ou réponds directement à son message avec \`*ban raison\`.`,
    });
    return;
  }

  const reason =
    interaction.options.getString("reason") ?? "Aucune raison fournie.";

  if (user.id === interaction.client.user?.id) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je ne peux pas me bannir moi-même.`,
    });
    return;
  }

  const existingBan = await guild.bans.fetch(user.id).catch(() => null);
  if (existingBan) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}**${user.tag}** est déjà banni de ce serveur.`,
    });
    return;
  }

  const target = await guild.members.fetch(user.id).catch(() => null);

  // Le membre est encore présent sur le serveur : on applique les
  // vérifications de hiérarchie habituelles avant de bannir.
  if (target) {
    if (!(await canModerateTarget(interaction, target))) {
      await interaction.reply({
        content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
      });
      return;
    }

    if (!target.bannable || target.id === guild.ownerId) {
      await interaction.reply({
        content: `${moderationResultPrefix(guild, false)}Je ne peux pas bannir ce membre : son rôle est supérieur au mien ou il s’agit du propriétaire.`,
      });
      return;
    }

    await target
      .send(
        `Tu as été banni de **${guild.name}**.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
      )
      .catch(() => undefined);

    await target.ban({ reason });
  } else {
    // Le membre n'est plus/pas sur le serveur : Discord permet de bannir
    // n'importe quel identifiant valide, sans vérification de hiérarchie.
    await guild.bans.create(user.id, { reason });
  }

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "ban",
    targetId: user.id,
    targetTag: user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "ban",
    targetId: user.id,
    targetTag: user.tag,
    targetNickname: target?.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await interaction.reply({
    content: target
      ? `${moderationResultPrefix(guild, true)}**${user.tag}** a été banni. Raison : ${reason}${formatSanctionIdSuffix(sanctionId)}`
      : `${moderationResultPrefix(guild, true)}**${user.tag}** (hors serveur) a été banni. Raison : ${reason}${formatSanctionIdSuffix(sanctionId)}`,
  });
}

async function timeoutMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord « Modérer les membres ».`,
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const minutes = interaction.options.getInteger("minutes", true);
  const reason =
    interaction.options.getString("reason") ?? "Aucune raison fournie.";
  const target = await guild.members.fetch(user.id).catch(() => null);

  if (!target) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce membre ne fait pas partie de ce serveur.`,
    });
    return;
  }

  if (!(await canModerateTarget(interaction, target))) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
    });
    return;
  }

  if (!target.moderatable || target.id === guild.ownerId) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je ne peux pas mettre ce membre en timeout : son rôle est supérieur au mien ou il s’agit du propriétaire.`,
    });
    return;
  }

  await target
    .send(
      `Tu as reçu un timeout sur **${guild.name}** pendant **${minutes} minute(s)**.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
    )
    .catch(() => undefined);

  await target.timeout(minutes * 60 * 1000, reason);
  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "mute",
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
    durationMinutes: minutes,
  });
  await logSanction(guild, {
    sanctionId,
    action: "mute",
    targetId: target.id,
    targetTag: target.user.tag,
    targetNickname: target.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
    durationMinutes: minutes,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}**${target.user.tag}** est en timeout pendant **${minutes} minute(s)**. Raison : ${reason}${formatSanctionIdSuffix(sanctionId)}`,
  });
}

async function unmuteMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord « Modérer les membres ».`,
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const reason =
    interaction.options.getString("reason") ?? "Aucune raison fournie.";
  const target = await guild.members.fetch(user.id).catch(() => null);

  if (!target) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce membre ne fait pas partie de ce serveur.`,
    });
    return;
  }

  if (!(await canModerateTarget(interaction, target))) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
    });
    return;
  }

  if (!target.isCommunicationDisabled()) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}**${target.user.tag}** n’est actuellement pas en timeout.`,
    });
    return;
  }

  if (!target.moderatable) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je ne peux pas modifier ce membre : son rôle est supérieur au mien.`,
    });
    return;
  }

  await target.timeout(null, reason);
  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "unmute",
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "unmute",
    targetId: target.id,
    targetTag: target.user.tag,
    targetNickname: target.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}Le timeout de **${target.user.tag}** a été retiré. Raison : ${reason}`,
  });
}

async function setChannelLock(
  interaction: ChatInputCommandInteraction,
  locked: boolean,
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !("permissionOverwrites" in channel)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce salon ne permet pas la gestion des permissions.`,
    });
    return;
  }

  const textChannel = channel as TextChannel;
  const botMember = guild.members.me;
  if (
    !botMember
      ?.permissionsIn(textChannel)
      .has(PermissionFlagsBits.ManageChannels)
  ) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord « Gérer le salon ».`,
    });
    return;
  }

  const reason =
    interaction.options.getString("reason") ??
    (locked ? "Salon verrouillé." : "Salon déverrouillé.");

  const settings = await getGuildSettings(guild.id);
  const lockTargetRoleIds = getGuildLockTargetRoleIds(settings);
  const moderationRoleIds = getGuildModerationRoleIds(settings);

  if (lockTargetRoleIds.length === 0) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Aucun rôle n’est configuré pour /lock (DISCORD_MEMBRETEMPO_ROLE_ID / DISCORD_MEMBRES_ROLE_ID). Contacte l’administrateur du bot.`,
    });
    return;
  }

  const referenceOverwrite = textChannel.permissionOverwrites.cache.get(
    lockTargetRoleIds[0],
  );
  const alreadyLocked =
    referenceOverwrite?.deny.has(PermissionFlagsBits.SendMessages) ?? false;

  if (locked && alreadyLocked) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce salon est déjà verrouillé.`,
    });
    return;
  }

  if (!locked && !alreadyLocked) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce salon n’est pas verrouillé.`,
    });
    return;
  }

  for (const roleId of lockTargetRoleIds) {
    await textChannel.permissionOverwrites.edit(
      roleId,
      { SendMessages: locked ? false : true },
      { reason },
    );
  }

  if (settings.roleIds.gif) {
    await textChannel.permissionOverwrites.edit(
      settings.roleIds.gif,
      { EmbedLinks: locked ? false : true },
      { reason },
    );
  }

  for (const roleId of moderationRoleIds) {
    if (lockTargetRoleIds.includes(roleId)) {
      continue;
    }

    await textChannel.permissionOverwrites.edit(
      roleId,
      { SendMessages: locked ? true : null },
      { reason },
    );
  }

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle(locked ? "Salon verrouillé" : "Salon déverrouillé")
      .setColor(locked ? 0xc0392b : 0x2ecc71)
      .addFields(
        { name: "Salon", value: `<#${textChannel.id}>`, inline: true },
        {
          name: "Modérateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
        { name: "Raison", value: reason },
      )
      .setTimestamp(),
    "locks",
  );

  await interaction.reply({
    content: locked
      ? `${moderationResultPrefix(guild, true)}🔒 Le salon a été verrouillé. Seuls les rôles de modération peuvent désormais y écrire. Raison : ${reason}`
      : `${moderationResultPrefix(guild, true)}🔓 Le salon a été déverrouillé. Raison : ${reason}`,
  });
}

async function lockChannel(interaction: ChatInputCommandInteraction) {
  await setChannelLock(interaction, true);
}

async function unlockChannel(interaction: ChatInputCommandInteraction) {
  await setChannelLock(interaction, false);
}

async function unbanMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission Discord « Bannir des membres ».`,
    });
    return;
  }

  const userId = interaction.options.getString("user_id", true);
  const reason =
    interaction.options.getString("reason") ?? "Aucune raison fournie.";

  if (!/^\d{17,20}$/.test(userId)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}L’identifiant fourni n’est pas un identifiant Discord valide.`,
    });
    return;
  }

  const ban = await guild.bans.fetch(userId).catch(() => null);

  if (!ban) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce membre n’est pas banni de ce serveur.`,
    });
    return;
  }

  await guild.members.unban(userId, reason);
  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "unban",
    targetId: ban.user.id,
    targetTag: ban.user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "unban",
    targetId: ban.user.id,
    targetTag: ban.user.tag,
    targetNickname: null,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}**${ban.user.tag}** a été débanni. Raison : ${reason}`,
  });
}

// Construit un transcript lisible (façon transcript de ticket) des messages
// supprimés par *clearmember, dans l'ordre chronologique.
function buildClearTranscript(
  channel: TextChannel,
  messages: Collection<string, Message>,
): string {
  const sorted = [...messages.values()].sort(
    (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0),
  );

  const header = [
    `Transcript de suppression — #${channel.name} (${channel.id})`,
    `${sorted.length} message(s) — généré le ${new Date().toISOString()}`,
    "=".repeat(60),
  ].join("\n");

  const body = sorted
    .map((msg) => {
      const timestamp = msg.createdAt
        ? msg.createdAt.toISOString()
        : "date inconnue";
      const author = msg.author
        ? `${msg.author.tag} (${msg.author.id})`
        : "Auteur inconnu";
      const content =
        msg.content && msg.content.length > 0
          ? msg.content
          : "(pas de contenu texte — embed, composant ou message vide)";
      const attachments = msg.attachments?.size
        ? `\nPièce(s) jointe(s) : ${[...msg.attachments.values()]
            .map((attachment) => attachment.url)
            .join(", ")}`
        : "";

      return `[${timestamp}] ${author} :\n${content}${attachments}`;
    })
    .join("\n\n");

  return `${header}\n\n${body}`;
}

async function clearMessages(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const guild = interaction.guild;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission « Gérer les messages ».`,
    });
    return;
  }

  const selectedChannel = interaction.channel;
  if (
    !selectedChannel ||
    (selectedChannel.type !== ChannelType.GuildText &&
      selectedChannel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Le salon actuel ne permet pas la suppression groupée de messages.`,
    });
    return;
  }

  const amount = interaction.options.getInteger("amount", true);
  const channel = selectedChannel as TextChannel;
  const fetched = await channel.messages.fetch({ limit: amount });
  if (fetched.size === 0) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Aucun message récent n’a été trouvé dans <#${channel.id}>.`,
    });
    return;
  }

  const deleted = await channel.bulkDelete(fetched, true);
  const transcript = buildClearTranscript(
    channel,
    deleted as Collection<string, Message>,
  );
  const transcriptFile = new AttachmentBuilder(
    Buffer.from(transcript, "utf-8"),
    { name: `clear-${channel.id}-${Date.now()}.txt` },
  );

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("Messages supprimés")
      .setColor(0xe67e22)
      .addFields(
        {
          name: "Modérateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
        { name: "Salon", value: `<#${channel.id}>`, inline: true },
        { name: "Type", value: "Purge générale", inline: true },
        { name: "Nombre", value: String(deleted.size), inline: true },
      )
      .setFooter({ text: "Transcript des messages en pièce jointe." })
      .setTimestamp(),
    "messages",
    [transcriptFile],
  );

  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}${deleted.size} message(s) supprimé(s) dans <#${channel.id}>.`,
  });
}

async function writeAuditLog(input: {
  guildId: string;
  action: string;
  actorId?: string | null;
  actorTag?: string | null;
  targetId?: string | null;
  targetTag?: string | null;
  details?: string;
  notifyChannel?: boolean;
}) {
  await db.insert(discordAuditLogsTable).values({
    guildId: input.guildId,
    action: input.action,
    actorId: input.actorId ?? null,
    actorTag: input.actorTag ?? null,
    targetId: input.targetId ?? null,
    targetTag: input.targetTag ?? null,
    details: input.details ?? "",
  });

  if (input.notifyChannel !== true) {
    return;
  }

  const guild = activeDiscordClient?.guilds.cache.get(input.guildId);
  if (!guild) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🧾 Action d’une fonctionnalité")
    .setColor(0x5865f2)
    .addFields(
      { name: "Action", value: input.action, inline: true },
      ...(input.actorTag
        ? [{ name: "Auteur", value: `${input.actorTag}\n\`${input.actorId ?? "inconnu"}\``, inline: true }]
        : []),
      ...(input.targetTag
        ? [{ name: "Cible", value: `${input.targetTag}\n\`${input.targetId ?? "inconnue"}\``, inline: true }]
        : []),
      { name: "Détails", value: (input.details ?? "Aucun détail").slice(0, 1024) },
    )
    .setTimestamp();

  await logToGuild(guild, embed, "features").catch((err) =>
    logger.error({ err, guildId: input.guildId }, "Failed to log feature audit"),
  );
}

async function sendSecurityAlert(
  guild: Guild,
  title: string,
  description: string,
  details: Record<string, string> = {},
) {
  const cooldownKey = `${guild.id}:${title}`;
  const now = Date.now();
  if (
    now - (SECURITY_ALERT_COOLDOWNS.get(cooldownKey) ?? 0) <
    SECURITY_ALERT_COOLDOWN_MS
  ) {
    return;
  }
  SECURITY_ALERT_COOLDOWNS.set(cooldownKey, now);

  const embed = new EmbedBuilder()
    .setTitle(`🚨 ${title}`)
    .setDescription(description)
    .setColor(0xe74c3c)
    .addFields(
      ...Object.entries(details).map(([name, value]) => ({
        name,
        value: value.slice(0, 1024),
        inline: true,
      })),
    )
    .setTimestamp();

  const channelId = LOG_CHANNEL_IDS.features;
  const channel = channelId
    ? await guild.channels.fetch(channelId).catch(() => null)
    : null;
  if (channel && "send" in channel) {
    await channel
      .send({
        content: `<@${BOT_OWNER_ID}>`,
        embeds: [embed],
        allowedMentions: { users: [BOT_OWNER_ID] },
      })
      .catch((err) => logger.error({ err }, "Failed to send security alert"));
  } else {
    await logToGuild(guild, embed, "features").catch((err) =>
      logger.error({ err }, "Failed to log security alert"),
    );
  }

  await writeAuditLog({
    guildId: guild.id,
    action: "security_alert",
    details: `${title}: ${description}`,
    notifyChannel: false,
  }).catch((err) => logger.error({ err }, "Failed to save security audit"));
}

async function getSecurityConfig(guildId: string) {
  const [existing] = await db
    .select()
    .from(discordSecurityConfigsTable)
    .where(eq(discordSecurityConfigsTable.guildId, guildId))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(discordSecurityConfigsTable)
    .values({ guildId })
    .returning();
  if (!created) {
    throw new Error("La configuration de sécurité n’a pas pu être créée.");
  }
  return created;
}

function securityIndicator(
  count: number,
  threshold: number,
  enabled: boolean,
): string {
  if (!enabled) {
    return "désactivé";
  }

  const state =
    count >= threshold
      ? "SEUIL ATTEINT"
      : count >= Math.max(1, threshold - 2)
        ? "surveillance"
        : "normal";
  return `${state} — ${count}/${threshold}`;
}

function recentSecurityJoinMembers(guildId: string, now = Date.now()) {
  const recent = (SECURITY_JOIN_MEMBERS.get(guildId) ?? []).filter(
    (entry) => now - entry.timestamp < RAID_JOIN_WINDOW_MS,
  );
  SECURITY_JOIN_MEMBERS.set(guildId, recent);
  return recent;
}

function recentSecurityMessageCount(guildId: string, userId: string, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const recent = trimWindow(
    SECURITY_MESSAGE_WINDOWS.get(key) ?? [],
    now,
    SPAM_WINDOW_MS,
  );
  if (recent.length > 0) {
    SECURITY_MESSAGE_WINDOWS.set(key, recent);
  } else {
    SECURITY_MESSAGE_WINDOWS.delete(key);
  }
  return recent.length;
}

function recentSecurityNukeCount(guildId: string, userId: string, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const recent = trimWindow(
    SECURITY_NUKE_WINDOWS.get(key) ?? [],
    now,
    ANTI_NUKE_WINDOW_MS,
  );
  if (recent.length > 0) {
    SECURITY_NUKE_WINDOWS.set(key, recent);
  } else {
    SECURITY_NUKE_WINDOWS.delete(key);
  }
  return recent.length;
}

async function getSecurityDetectionCount(
  guildId: string,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ detectionCount: discordSecurityDetectionsTable.detectionCount })
    .from(discordSecurityDetectionsTable)
    .where(
      and(
        eq(discordSecurityDetectionsTable.guildId, guildId),
        eq(discordSecurityDetectionsTable.userId, userId),
      ),
    )
    .limit(1);
  return row?.detectionCount ?? 0;
}

async function recordSecurityDetection(
  guild: Guild,
  member: GuildMember,
  source: "anti-spam" | "anti-raid",
): Promise<number | null> {
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    isProtectedSecurityTarget(guild, member)
  ) {
    return null;
  }

  const now = new Date();
  try {
    const [row] = await db
      .insert(discordSecurityDetectionsTable)
      .values({
        guildId: guild.id,
        userId: member.id,
        detectionCount: 1,
        lastDetectedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          discordSecurityDetectionsTable.guildId,
          discordSecurityDetectionsTable.userId,
        ],
        set: {
          detectionCount: sql`${discordSecurityDetectionsTable.detectionCount} + 1`,
          lastDetectedAt: now,
          updatedAt: now,
        },
      })
      .returning({
        detectionCount: discordSecurityDetectionsTable.detectionCount,
      });

    logger.info(
      {
        guildId: guild.id,
        userId: member.id,
        source,
        detectionCount: row?.detectionCount ?? 1,
      },
      "Security detection recorded",
    );
    return row?.detectionCount ?? (await getSecurityDetectionCount(guild.id, member.id));
  } catch (err) {
    logger.error(
      { err, guildId: guild.id, userId: member.id, source },
      "Failed to record security detection",
    );
    return null;
  }
}

async function inspectSecurity(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  config: Awaited<ReturnType<typeof getSecurityConfig>>,
) {
  const requestedUser = interaction.options.getUser("member");
  const now = Date.now();
  const recentJoins = recentSecurityJoinMembers(guild.id, now);
  const raidCount = recentJoins.length;
  const spamThreshold = Math.min(
    MAX_SPAM_THRESHOLD,
    Math.max(MIN_SPAM_THRESHOLD, config.spamThreshold ?? MIN_SPAM_THRESHOLD),
  );
  const nukeThreshold = DEFAULT_ANTI_NUKE_THRESHOLD;

  if (requestedUser) {
    const member = await guild.members.fetch(requestedUser.id).catch(() => null);
    const spamCount = recentSecurityMessageCount(guild.id, requestedUser.id, now);
    const nukeCount = recentSecurityNukeCount(guild.id, requestedUser.id, now);
    const detectionCount = await getSecurityDetectionCount(
      guild.id,
      requestedUser.id,
    );
    const joinEntry = recentJoins.find(
      (entry) => entry.userId === requestedUser.id,
    );
    const isAdministrator = Boolean(
      member?.permissions.has(PermissionFlagsBits.Administrator),
    );
    const isProtected = member ? isProtectedSecurityTarget(guild, member) : false;

    const embed = new EmbedBuilder()
      .setTitle(`🔎 Sécurité — ${requestedUser.tag}`)
      .setColor(0x5865f2)
      .addFields(
        {
          name: "Membre",
          value: [
            `ID : \`${requestedUser.id}\``,
            `Administrateur : ${isAdministrator ? "oui" : "non"}`,
            `Compte protégé : ${isProtected ? "oui" : "non"}`,
            `Détections anti-spam/anti-raid : ${detectionCount}`,
            member?.communicationDisabledUntilTimestamp
              ? `Timeout : <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>`
              : "Timeout : non",
          ].join("\n"),
        },
        {
          name: "Anti-spam",
          value: [
            securityIndicator(
              spamCount,
              spamThreshold,
              Boolean(config.antiSpamEnabled),
            ),
            `Fenêtre : ${SPAM_WINDOW_MS / 1000} secondes`,
          ].join("\n"),
        },
        {
          name: "Anti-raid",
          value: [
            `État serveur : ${config.antiRaidEnabled ? "activé" : "désactivé"}`,
            `Arrivées actuelles : ${raidCount}/${RAID_JOIN_THRESHOLD} en 60 secondes`,
            joinEntry
              ? `Ce membre est arrivé <t:${Math.floor(joinEntry.timestamp / 1000)}:R>`
              : "Ce membre n’est pas dans la fenêtre d’arrivées actuelle.",
          ].join("\n"),
        },
        {
          name: "Anti-nuke",
          value: [
            securityIndicator(
              nukeCount,
              nukeThreshold,
              Boolean(config.antiNukeEnabled),
            ),
            `Fenêtre : ${ANTI_NUKE_WINDOW_MS / 1000} secondes`,
          ].join("\n"),
        },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const trackedSpam = [...SECURITY_MESSAGE_WINDOWS.entries()]
    .filter(([key]) => key.startsWith(`${guild.id}:`))
    .map(([key]) => {
      const userId = key.slice(guild.id.length + 1);
      return {
        userId,
        count: recentSecurityMessageCount(guild.id, userId, now),
      };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const trackedNuke = [...SECURITY_NUKE_WINDOWS.entries()]
    .filter(([key]) => key.startsWith(`${guild.id}:`))
    .map(([key]) => {
      const userId = key.slice(guild.id.length + 1);
      return {
        userId,
        count: recentSecurityNukeCount(guild.id, userId, now),
      };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const spamLines =
    trackedSpam.length > 0
      ? trackedSpam
          .slice(0, 15)
          .map(
            (entry) =>
              `• <@${entry.userId}> — ${securityIndicator(entry.count, spamThreshold, Boolean(config.antiSpamEnabled))}`,
          )
          .join("\n")
      : "Aucun membre actuellement suivi.";
  const nukeLines =
    trackedNuke.length > 0
      ? trackedNuke
          .slice(0, 15)
          .map(
            (entry) =>
              `• <@${entry.userId}> — ${securityIndicator(entry.count, nukeThreshold, Boolean(config.antiNukeEnabled))}`,
          )
          .join("\n")
      : "Aucun exécuteur actuellement suivi.";
  const raidMembers =
    recentJoins.length > 0
      ? recentJoins
          .slice(-15)
          .reverse()
          .map(
            (entry) =>
              `• <@${entry.userId}> — arrivé <t:${Math.floor(entry.timestamp / 1000)}:R>`,
          )
          .join("\n")
      : "Aucune arrivée dans la fenêtre actuelle.";

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Inspection sécurité — ${guild.name}`)
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Configuration",
        value: [
          `Anti-spam : ${config.antiSpamEnabled ? "activé" : "désactivé"} — seuil ${spamThreshold}/10 s`,
          `Anti-raid : ${config.antiRaidEnabled ? "activé" : "désactivé"} — ${raidCount}/${RAID_JOIN_THRESHOLD}/60 s`,
          `Anti-nuke : ${config.antiNukeEnabled ? "activé" : "désactivé"} — seuil ${nukeThreshold}/${ANTI_NUKE_WINDOW_MS / 1000} s`,
        ].join("\n"),
      },
      { name: "Membres suivis par l’anti-spam", value: spamLines.slice(0, 1024) },
      { name: "Arrivées suivies par l’anti-raid", value: raidMembers.slice(0, 1024) },
      { name: "Exécuteurs suivis par l’anti-nuke", value: nukeLines.slice(0, 1024) },
    )
    .setFooter({
      text: "Inspection réservée aux administrateurs • maximum 15 entrées par catégorie",
    })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function applySecurityLockdown(guild: Guild, enabled: boolean) {
  const channels = guild.channels.cache.filter(
    (channel) =>
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement,
  );
  let changed = 0;
  for (const channel of channels.values()) {
    await channel.permissionOverwrites
      .edit(
        guild.roles.everyone,
        { SendMessages: enabled ? false : null },
        { reason: enabled ? "Lockdown anti-raid" : "Fin du lockdown anti-raid" },
      )
      .then(() => {
        changed += 1;
      })
      .catch((err) =>
        logger.warn(
          { err, guildId: guild.id, channelId: channel.id },
          "Failed to update lockdown permission",
        ),
      );
  }
  SECURITY_LOCKDOWNS[enabled ? "add" : "delete"](guild.id);
  await db
    .insert(discordSecurityConfigsTable)
    .values({ guildId: guild.id, lockdown: enabled ? 1 : 0 })
    .onConflictDoUpdate({
      target: discordSecurityConfigsTable.guildId,
      set: { lockdown: enabled ? 1 : 0, updatedAt: new Date() },
    });
  return changed;
}

async function restoreSecurityLockdowns(client: DiscordClient<boolean>) {
  const lockedGuilds = await db
    .select({ guildId: discordSecurityConfigsTable.guildId })
    .from(discordSecurityConfigsTable)
    .where(eq(discordSecurityConfigsTable.lockdown, 1));

  for (const { guildId } of lockedGuilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }
    await applySecurityLockdown(guild, true).catch((err) =>
      logger.error({ err, guildId }, "Failed to restore security lockdown"),
    );
  }
}

async function handleSecurityCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const isOwner = await isBotOwnerInteraction(interaction);
  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator,
  );
  if (!isOwner && !isAdmin) {
    await interaction.reply({
      content: "Cette commande est réservée à la modération.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (
    subcommand === "inspect" &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: "Cette inspection est réservée aux membres ayant la permission Administrateur.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "status") {
    const config = await getSecurityConfig(guild.id);
    await interaction.reply({
      content: [
        `🛡️ Anti-spam : ${config.antiSpamEnabled ? "activé" : "désactivé"}`,
        `📨 Seuil anti-spam : ${config.spamThreshold} messages / 10 secondes`,
        `🚪 Anti-raid : ${config.antiRaidEnabled ? "activé" : "désactivé"}`,
        `💥 Anti-nuke : ${config.antiNukeEnabled ? "activé" : "désactivé"}`,
        `🧨 Seuil anti-nuke : ${DEFAULT_ANTI_NUKE_THRESHOLD} actions / ${ANTI_NUKE_WINDOW_MS / 1000} secondes`,
        `🔒 Lockdown : ${config.lockdown ? "actif" : "inactif"}`,
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "inspect") {
    await inspectSecurity(interaction, guild, await getSecurityConfig(guild.id));
    return;
  }

  if (subcommand === "lockdown" || subcommand === "unlock") {
    const enabled = subcommand === "lockdown";
    const changed = await applySecurityLockdown(guild, enabled);
    await writeAuditLog({
      guildId: guild.id,
      action: enabled ? "security_lockdown" : "security_unlock",
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      details: `${changed} salon(s) modifié(s)`,
      notifyChannel: true,
    });
    await interaction.reply({
      content: `${enabled ? "🔒 Lockdown activé" : "🔓 Lockdown désactivé"} sur ${changed} salon(s).`,
      ephemeral: true,
    });
    return;
  }

  const feature = interaction.options.getString("feature", true);
  const enabled = interaction.options.getBoolean("enabled", true);
  const threshold = interaction.options.getInteger("threshold");
  const field =
    feature === "antispam"
      ? {
          antiSpamEnabled: enabled ? 1 : 0,
          ...(threshold !== null
            ? {
                spamThreshold: Math.min(
                  MAX_SPAM_THRESHOLD,
                  Math.max(MIN_SPAM_THRESHOLD, threshold),
                ),
              }
            : {}),
        }
      : feature === "antiraid"
        ? { antiRaidEnabled: enabled ? 1 : 0 }
        : {
            antiNukeEnabled: enabled ? 1 : 0,
            antiNukeThreshold: DEFAULT_ANTI_NUKE_THRESHOLD,
          };
  await db
    .insert(discordSecurityConfigsTable)
    .values({ guildId: guild.id, ...field })
    .onConflictDoUpdate({
      target: discordSecurityConfigsTable.guildId,
      set: { ...field, updatedAt: new Date() },
    });
  await writeAuditLog({
    guildId: guild.id,
    action: "security_config",
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    details:
      feature === "antinuke"
        ? `${feature}=${enabled}, threshold=${DEFAULT_ANTI_NUKE_THRESHOLD}, window=${ANTI_NUKE_WINDOW_MS / 1000}s`
        : `${feature}=${enabled}${threshold !== null ? `, threshold=${threshold}` : ""}`,
  });
  await interaction.reply({
    content: `✅ ${
      feature === "antispam"
        ? "Anti-spam"
        : feature === "antiraid"
          ? "Anti-raid"
          : "Anti-nuke"
    } ${enabled ? "activé" : "désactivé"}${
      feature === "antinuke"
        ? ` (seuil fixe : ${DEFAULT_ANTI_NUKE_THRESHOLD} actions / ${ANTI_NUKE_WINDOW_MS / 1000} secondes)`
        : threshold !== null
          ? ` (seuil : ${threshold})`
          : ""
    }.`,
    ephemeral: true,
  });
}

async function buildBackupPayload(guildId: string) {
  const [
    levels,
    profiles,
    sanctions,
    securityDetections,
    customRoles,
    reports,
    reportNotes,
    missions,
    missionProgress,
    missionPublications,
    securityConfigs,
    auditLogs,
    badges,
    memberBadges,
    guardians,
  ] = await Promise.all([
    db.select().from(discordLevelsTable).where(eq(discordLevelsTable.guildId, guildId)),
    db.select().from(discordMemberProfilesTable).where(eq(discordMemberProfilesTable.guildId, guildId)),
    db.select().from(discordSanctionsTable).where(eq(discordSanctionsTable.guildId, guildId)),
    db.select().from(discordSecurityDetectionsTable).where(eq(discordSecurityDetectionsTable.guildId, guildId)),
    db.select().from(discordCustomRolesTable).where(eq(discordCustomRolesTable.guildId, guildId)),
    db.select().from(discordReportsTable).where(eq(discordReportsTable.guildId, guildId)),
    db.select({
      note: discordReportNotesTable,
      reportGuildId: discordReportsTable.guildId,
    }).from(discordReportNotesTable).innerJoin(
      discordReportsTable,
      eq(discordReportsTable.id, discordReportNotesTable.reportId),
    ).where(eq(discordReportsTable.guildId, guildId)),
    db.select().from(discordMissionsTable).where(eq(discordMissionsTable.guildId, guildId)),
    db.select().from(discordMissionProgressTable).where(eq(discordMissionProgressTable.guildId, guildId)),
    db.select().from(discordMissionPublicationsTable).where(eq(discordMissionPublicationsTable.guildId, guildId)),
    db.select().from(discordSecurityConfigsTable).where(eq(discordSecurityConfigsTable.guildId, guildId)),
    db.select().from(discordAuditLogsTable).where(eq(discordAuditLogsTable.guildId, guildId)),
    db.select().from(discordBadgesTable).where(eq(discordBadgesTable.guildId, guildId)),
    db.select().from(discordMemberBadgesTable).where(eq(discordMemberBadgesTable.guildId, guildId)),
    db.select().from(discordGuardianProfilesTable).where(eq(discordGuardianProfilesTable.guildId, guildId)),
  ]);
  return JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    guildId,
    levels,
    profiles,
    sanctions,
    securityDetections,
    customRoles,
    reports,
    reportNotes: reportNotes.map(({ note }) => note),
    missions,
    missionProgress,
    missionPublications,
    securityConfigs,
    auditLogs,
    badges,
    memberBadges,
    guardians,
  });
}

async function handleBackupCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild || !(await isBotOwnerInteraction(interaction))) {
    await interaction.reply({
      content: "Les sauvegardes sont réservées au propriétaire du bot.",
      ephemeral: true,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    const payload = await buildBackupPayload(guild.id);
    const [backup] = await db
      .insert(discordBackupsTable)
      .values({
        guildId: guild.id,
        createdById: interaction.user.id,
        createdByTag: interaction.user.tag,
        payload,
      })
      .returning({ id: discordBackupsTable.id });
    await interaction.reply({
      content: `✅ Sauvegarde **#${backup?.id ?? "?"}** créée (${Math.round(payload.length / 1024)} Ko).`,
      ephemeral: true,
    });
    return;
  }
  if (subcommand === "list") {
    const backups = await db
      .select({
        id: discordBackupsTable.id,
        createdAt: discordBackupsTable.createdAt,
        createdByTag: discordBackupsTable.createdByTag,
      })
      .from(discordBackupsTable)
      .where(eq(discordBackupsTable.guildId, guild.id))
      .orderBy(desc(discordBackupsTable.createdAt))
      .limit(20);
    await interaction.reply({
      content:
        backups.length > 0
          ? backups
              .map((backup) => `#${backup.id} — ${formatDate(backup.createdAt)} — ${backup.createdByTag}`)
              .join("\n")
          : "Aucune sauvegarde.",
      ephemeral: true,
    });
    return;
  }
  const backupId = interaction.options.getInteger("id", true);
  const confirm = interaction.options.getBoolean("confirm", true);
  if (!confirm) {
    await interaction.reply({
      content: "La restauration nécessite `confirm: true`.",
      ephemeral: true,
    });
    return;
  }
  const [backup] = await db
    .select()
    .from(discordBackupsTable)
    .where(
      and(
        eq(discordBackupsTable.id, backupId),
        eq(discordBackupsTable.guildId, guild.id),
      ),
    )
    .limit(1);
  if (!backup) {
    await interaction.reply({ content: "Sauvegarde introuvable.", ephemeral: true });
    return;
  }
  const snapshot = JSON.parse(backup.payload) as {
    levels: Array<any>;
    profiles: Array<any>;
    sanctions: Array<any>;
    securityDetections?: Array<any>;
    customRoles: Array<any>;
    reports: Array<any>;
    reportNotes: Array<any>;
    missions: Array<any>;
    missionProgress: Array<any>;
    missionPublications: Array<any>;
    securityConfigs: Array<any>;
    auditLogs: Array<any>;
    badges: Array<any>;
    memberBadges: Array<any>;
    guardians: Array<any>;
  };
  await db.delete(discordMemberProfilesTable).where(eq(discordMemberProfilesTable.guildId, guild.id));
  await db.delete(discordMemberBadgesTable).where(eq(discordMemberBadgesTable.guildId, guild.id));
  await db.delete(discordMissionProgressTable).where(eq(discordMissionProgressTable.guildId, guild.id));
  await db.delete(discordMissionPublicationsTable).where(eq(discordMissionPublicationsTable.guildId, guild.id));
  await db.delete(discordReportNotesTable).where(
    inArray(
      discordReportNotesTable.reportId,
      db.select({ id: discordReportsTable.id }).from(discordReportsTable).where(eq(discordReportsTable.guildId, guild.id)),
    ),
  );
  await db.delete(discordReportsTable).where(eq(discordReportsTable.guildId, guild.id));
  await db.delete(discordCustomRolesTable).where(eq(discordCustomRolesTable.guildId, guild.id));
  await db.delete(discordSecurityConfigsTable).where(eq(discordSecurityConfigsTable.guildId, guild.id));
  await db.delete(discordLevelsTable).where(eq(discordLevelsTable.guildId, guild.id));
  await db.delete(discordSanctionsTable).where(eq(discordSanctionsTable.guildId, guild.id));
  await db.delete(discordSecurityDetectionsTable).where(eq(discordSecurityDetectionsTable.guildId, guild.id));
  await db.delete(discordMissionsTable).where(eq(discordMissionsTable.guildId, guild.id));
  await db.delete(discordBadgesTable).where(eq(discordBadgesTable.guildId, guild.id));
  await db.delete(discordGuardianProfilesTable).where(eq(discordGuardianProfilesTable.guildId, guild.id));
  if (snapshot.profiles.length) await db.insert(discordMemberProfilesTable).values(snapshot.profiles.map((row) => ({ ...row, joinedAt: row.joinedAt ? new Date(row.joinedAt) : null, lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null, updatedAt: new Date(row.updatedAt) })));
  if (snapshot.levels.length) await db.insert(discordLevelsTable).values(snapshot.levels.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) })));
  if (snapshot.sanctions.length) await db.insert(discordSanctionsTable).values(snapshot.sanctions.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })));
  if (snapshot.securityDetections?.length) await db.insert(discordSecurityDetectionsTable).values(snapshot.securityDetections.map((row) => ({ ...row, lastDetectedAt: new Date(row.lastDetectedAt), updatedAt: new Date(row.updatedAt) })));
  if (snapshot.customRoles.length) await db.insert(discordCustomRolesTable).values(snapshot.customRoles.map((row) => ({ ...row, createdAt: new Date(row.createdAt), expiresAt: new Date(row.expiresAt) })));
  if (snapshot.reports.length) await db.insert(discordReportsTable).values(snapshot.reports.map((row) => ({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt), closedAt: row.closedAt ? new Date(row.closedAt) : null })));
  if (snapshot.reportNotes.length) await db.insert(discordReportNotesTable).values(snapshot.reportNotes.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })));
  if (snapshot.missions.length) await db.insert(discordMissionsTable).values(snapshot.missions.map((row) => ({ ...row, startsAt: new Date(row.startsAt), endsAt: new Date(row.endsAt), createdAt: new Date(row.createdAt) })));
  if (snapshot.missionProgress.length) await db.insert(discordMissionProgressTable).values(snapshot.missionProgress.map((row) => ({ ...row, completedAt: row.completedAt ? new Date(row.completedAt) : null, rewardedAt: row.rewardedAt ? new Date(row.rewardedAt) : null })));
  if (snapshot.missionPublications.length) await db.insert(discordMissionPublicationsTable).values(snapshot.missionPublications.map((row) => ({ ...row, weekStart: new Date(row.weekStart), publishedAt: new Date(row.publishedAt) })));
  if (snapshot.securityConfigs.length) await db.insert(discordSecurityConfigsTable).values(snapshot.securityConfigs.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) })));
  if (snapshot.auditLogs.length) await db.insert(discordAuditLogsTable).values(snapshot.auditLogs.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })));
  if (snapshot.badges.length) await db.insert(discordBadgesTable).values(snapshot.badges.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })));
  if (snapshot.memberBadges.length) await db.insert(discordMemberBadgesTable).values(snapshot.memberBadges.map((row) => ({ ...row, awardedAt: new Date(row.awardedAt) })));
  if (snapshot.guardians.length) await db.insert(discordGuardianProfilesTable).values(snapshot.guardians.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) })));
  await writeAuditLog({
    guildId: guild.id,
    action: "backup_restore",
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    details: `Sauvegarde #${backupId} restaurée`,
  });
  await interaction.reply({
    content: `✅ Sauvegarde **#${backupId}** restaurée. Les données du serveur ont été remplacées.`,
    ephemeral: true,
  });
}

const DEFAULT_COSMO_BADGES = [
  {
    code: "cosmo-initie",
    name: "Cosmo Initié",
    description: "A atteint 1 000 XP sur le serveur.",
    emoji: "🌟",
    requiredXp: 1_000,
  },
  {
    code: "cosmo-gardien",
    name: "Cosmo Gardien",
    description: "A atteint 5 000 XP sur le serveur.",
    emoji: "🛡️",
    requiredXp: 5_000,
  },
  {
    code: "cosmo-sentinelle",
    name: "Cosmo Sentinelle",
    description: "A atteint 10 000 XP sur le serveur.",
    emoji: "✨",
    requiredXp: 10_000,
  },
];

async function ensureDefaultBadges(guildId: string) {
  for (const badge of DEFAULT_COSMO_BADGES) {
    await db
      .insert(discordBadgesTable)
      .values({ guildId, ...badge })
      .onConflictDoNothing();
  }
  return db
    .select()
    .from(discordBadgesTable)
    .where(eq(discordBadgesTable.guildId, guildId));
}

async function syncXpBadges(guildId: string, userId: string, xp: number) {
  const badges = await ensureDefaultBadges(guildId);
  for (const badge of badges) {
    if (xp < badge.requiredXp) {
      continue;
    }
    await db
      .insert(discordMemberBadgesTable)
      .values({ guildId, userId, badgeId: badge.id })
      .onConflictDoNothing();
  }
}

async function addGuardianXp(
  guildId: string,
  userId: string,
  amount: number,
) {
  if (amount <= 0) {
    return 0;
  }
  const [profile] = await db
    .insert(discordGuardianProfilesTable)
    .values({ guildId, userId, guardianXp: amount })
    .onConflictDoUpdate({
      target: [
        discordGuardianProfilesTable.guildId,
        discordGuardianProfilesTable.userId,
      ],
      set: {
        guardianXp: sql`${discordGuardianProfilesTable.guardianXp} + ${amount}`,
        updatedAt: new Date(),
      },
    })
    .returning({ guardianXp: discordGuardianProfilesTable.guardianXp });
  return profile?.guardianXp ?? amount;
}

async function advanceTriggeredMissions(
  guild: Guild,
  userId: string,
  triggerEvent: string,
  amount = 1,
) {
  const missions = await db
    .select()
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.guildId, guild.id),
        eq(discordMissionsTable.status, "active"),
        eq(discordMissionsTable.triggerEvent, triggerEvent),
        gt(discordMissionsTable.endsAt, new Date()),
      ),
    );

  for (const mission of missions) {
    await db
      .insert(discordMissionProgressTable)
      .values({
        missionId: mission.id,
        guildId: guild.id,
        userId,
      })
      .onConflictDoNothing();

    const [existing] = await db
      .select()
      .from(discordMissionProgressTable)
      .where(
        and(
          eq(discordMissionProgressTable.missionId, mission.id),
          eq(discordMissionProgressTable.userId, userId),
        ),
      )
      .limit(1);
    if (!existing?.rewardedAt) {
      const next = nextMissionProgress(
        existing?.progress ?? 0,
        mission.targetCount,
      );
      const progress = Math.min(
        mission.targetCount,
        (existing?.progress ?? 0) + Math.max(1, amount),
      );
      const completed = progress >= mission.targetCount;
      const now = new Date();
      await db
        .update(discordMissionProgressTable)
        .set({
          progress: next.progress === progress ? next.progress : progress,
          completedAt: completed ? now : null,
          rewardedAt: completed ? now : null,
        })
        .where(eq(discordMissionProgressTable.id, existing!.id));

      if (completed) {
        await grantBonusXp(guild, userId, mission.rewardXp).catch((err) =>
          logger.error(
            { err, guildId: guild.id, userId, missionId: mission.id },
            "Failed to grant triggered mission XP",
          ),
        );
        await addGuardianXp(guild.id, userId, 25).catch((err) =>
          logger.error(
            { err, guildId: guild.id, userId, missionId: mission.id },
            "Failed to grant triggered guardian XP",
          ),
        );
        const resources = await ensureCosmoResources(guild);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(resources.guardianRoleId)) {
          await member.roles
            .add(resources.guardianRoleId, `Mission Cosmo CM-${mission.id} validée`)
            .catch((err) =>
              logger.warn(
                { err, guildId: guild.id, userId },
                "Failed to grant Cosmo guardian role",
              ),
            );
        }
      }
    }
  }
}

async function touchMemberProfile(
  member: GuildMember,
  options: { joined?: boolean } = {},
) {
  const now = new Date();
  await db
    .insert(discordMemberProfilesTable)
    .values({
      guildId: member.guild.id,
      userId: member.id,
      joinedAt: options.joined ? now : undefined,
      lastActiveAt: now,
    })
    .onConflictDoUpdate({
      target: [
        discordMemberProfilesTable.guildId,
        discordMemberProfilesTable.userId,
      ],
      set: {
        ...(options.joined ? { joinedAt: now } : {}),
        lastActiveAt: now,
        updatedAt: now,
      },
    });
}

async function handleBadgeCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const target = interaction.options.getUser("user") ?? interaction.user;
  const xp = await getUserXp(guild.id, target.id);
  await syncXpBadges(guild.id, target.id, xp);
  const rows = await db
    .select({
      badge: discordBadgesTable,
      awardedAt: discordMemberBadgesTable.awardedAt,
    })
    .from(discordMemberBadgesTable)
    .innerJoin(
      discordBadgesTable,
      eq(discordBadgesTable.id, discordMemberBadgesTable.badgeId),
    )
    .where(
      and(
        eq(discordMemberBadgesTable.guildId, guild.id),
        eq(discordMemberBadgesTable.userId, target.id),
      ),
    )
    .orderBy(asc(discordMemberBadgesTable.awardedAt));
  const [guardian] = await db
    .select()
    .from(discordGuardianProfilesTable)
    .where(
      and(
        eq(discordGuardianProfilesTable.guildId, guild.id),
        eq(discordGuardianProfilesTable.userId, target.id),
      ),
    )
    .limit(1);
  const guardianLevel = Math.floor((guardian?.guardianXp ?? 0) / 100) + 1;
  const description =
    rows.length > 0
      ? rows
          .map(
            ({ badge }) =>
              `${badge.emoji} **${badge.name}** — ${badge.description}`,
          )
          .join("\n")
      : "Aucun badge pour le moment.";
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`🏅 Profil de ${target.tag}`)
        .setThumbnail(target.displayAvatarURL())
        .setColor(0x8e44ad)
        .setDescription(description)
        .addFields(
          { name: "XP", value: String(xp), inline: true },
          {
            name: "Niveau de gardien",
            value: `Niveau ${guardianLevel} (${guardian?.guardianXp ?? 0} XP Gardien)`,
            inline: true,
          },
        ),
    ],
  });
}

async function handleProfileCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const target = interaction.options.getUser("user") ?? interaction.user;
  if (subcommand === "edit") {
    const bio = interaction.options.getString("bio");
    const favoriteGame = interaction.options.getString("favorite_game");
    const timezone = interaction.options.getString("timezone");
    if (bio === null && favoriteGame === null && timezone === null) {
      await interaction.reply({
        content: "Modifie au moins un champ du profil.",
        ephemeral: true,
      });
      return;
    }
    await db
      .insert(discordMemberProfilesTable)
      .values({
        guildId: guild.id,
        userId: interaction.user.id,
        bio: bio ?? "",
        favoriteGame,
        timezone,
        onboardingCompleted: 1,
        lastActiveAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          discordMemberProfilesTable.guildId,
          discordMemberProfilesTable.userId,
        ],
        set: {
          ...(bio === null ? {} : { bio }),
          ...(favoriteGame === null ? {} : { favoriteGame }),
          ...(timezone === null ? {} : { timezone }),
          onboardingCompleted: 1,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        },
      });
    await interaction.reply({
      content: "✅ Ton profil membre a été mis à jour.",
      ephemeral: true,
    });
    return;
  }

  const [profile] = await db
    .select()
    .from(discordMemberProfilesTable)
    .where(
      and(
        eq(discordMemberProfilesTable.guildId, guild.id),
        eq(discordMemberProfilesTable.userId, target.id),
      ),
    )
    .limit(1);
  const xp = await getUserXp(guild.id, target.id);
  const [guardian] = await db
    .select()
    .from(discordGuardianProfilesTable)
    .where(
      and(
        eq(discordGuardianProfilesTable.guildId, guild.id),
        eq(discordGuardianProfilesTable.userId, target.id),
      ),
    )
    .limit(1);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`👤 Profil de ${target.tag}`)
        .setThumbnail(target.displayAvatarURL())
        .setColor(0x3498db)
        .addFields(
          { name: "Bio", value: profile?.bio || "Aucune bio.", inline: false },
          {
            name: "Jeu préféré",
            value: profile?.favoriteGame ?? "Non renseigné",
            inline: true,
          },
          {
            name: "Fuseau",
            value: profile?.timezone ?? "Non renseigné",
            inline: true,
          },
          { name: "XP", value: String(xp), inline: true },
          {
            name: "Gardien",
            value: `Niveau ${guardianLevelForXp(guardian?.guardianXp ?? 0)} · ${guardian?.guardianXp ?? 0} XP`,
            inline: true,
          },
        ),
    ],
  });
}

async function clearMemberMessages(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const guild = interaction.guild;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Je n’ai pas la permission « Gérer les messages ».`,
    });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const selectedChannel = interaction.channel;
  if (
    !selectedChannel ||
    selectedChannel.type !== ChannelType.GuildText &&
    selectedChannel.type !== ChannelType.GuildAnnouncement
  ) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Le salon actuel ne permet pas la suppression groupée de messages.`,
    });
    return;
  }

  const amount = interaction.options.getInteger("amount", true);
  const channel = selectedChannel as TextChannel;
  const fetched = await channel.messages.fetch({ limit: 100 });
  const targetMessages = fetched
    .filter((message) => message.author.id === targetUser.id)
    .first(amount);

  if (targetMessages.length === 0) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Aucun message récent de ${targetUser} n’a été trouvé dans <#${channel.id}>.`,
    });
    return;
  }

  const deleted = await channel.bulkDelete(targetMessages, true);

  const transcript = buildClearTranscript(
    channel,
    deleted as Collection<string, Message>,
  );
  const transcriptFile = new AttachmentBuilder(
    Buffer.from(transcript, "utf-8"),
    { name: `clear-${channel.id}-${Date.now()}.txt` },
  );

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("Messages supprimés")
      .setColor(0xe67e22)
      .addFields(
        {
          name: "Modérateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
        { name: "Salon", value: `<#${channel.id}>`, inline: true },
         { name: "Membre", value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
        { name: "Nombre", value: String(deleted.size), inline: true },
      )
      .setFooter({ text: "Transcript des messages en pièce jointe." })
      .setTimestamp(),
    "messages",
    [transcriptFile],
  );
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}${deleted.size} message(s) de ${targetUser} supprimé(s) dans <#${channel.id}>.`,
  });
}

async function warnMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason", true);
  const target = await guild.members.fetch(user.id).catch(() => null);

  if (!target) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Ce membre ne fait pas partie de ce serveur.`,
    });
    return;
  }

  if (!(await canModerateTarget(interaction, target))) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
    });
    return;
  }

  if (target.id === interaction.user.id) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Tu ne peux pas t’avertir toi-même.`,
    });
    return;
  }

  await target
    .send(
      `Tu as reçu un avertissement sur **${guild.name}**.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${reason}`,
    )
    .catch(() => undefined);

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "warn",
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "warn",
    targetId: target.id,
    targetTag: target.user.tag,
    targetNickname: target.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}**${target.user.tag}** a reçu un avertissement. Raison : ${reason}${formatSanctionIdSuffix(sanctionId)}`,
  });
}

async function unwarnMember(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const reason =
    interaction.options.getString("reason") ?? "Aucune raison fournie.";
  const target = await guild.members.fetch(user.id).catch(() => null);
  const isAdmin =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
    false;

  if (target) {
    if (!isAdmin && !(await canModerateTarget(interaction, target))) {
      await interaction.reply({
        content: `${moderationResultPrefix(guild, false)}Tu ne peux pas modérer un membre ayant un rôle égal ou supérieur au tien.`,
      });
      return;
    }

    await target
      .send(
        `Un avertissement que tu avais reçu sur **${guild.name}** a été annulé.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${reason}`,
      )
      .catch(() => undefined);
  }

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "unwarn",
    targetId: user.id,
    targetTag: user.tag,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "unwarn",
    targetId: user.id,
    targetTag: user.tag,
    targetNickname: target?.nickname,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    reason,
  });
  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}L’avertissement de **${user.tag}** a été annulé. Raison : ${reason}`,
  });
}

// Détermine, pour tout le serveur, quels avertissements ("warn") ont déjà été
// annulés par un /unwarn. /unwarn ne cible qu'un membre (pas un ID de
// sanction précis) : chaque unwarn annule donc l'avertissement actif le plus
// ancien de ce membre (logique FIFO), pour rester cohérent avec l'ordre
// chronologique réel des sanctions.
async function getCancelledWarnSanctionIds(
  guildId: string,
): Promise<Set<number>> {
  const rows = await db
    .select({
      id: discordSanctionsTable.id,
      targetId: discordSanctionsTable.targetId,
      action: discordSanctionsTable.action,
    })
    .from(discordSanctionsTable)
    .where(
      and(
        eq(discordSanctionsTable.guildId, guildId),
        inArray(discordSanctionsTable.action, ["warn", "unwarn"]),
      ),
    )
    .orderBy(asc(discordSanctionsTable.createdAt));

  const activeWarnsByTarget = new Map<string, number[]>();
  const cancelled = new Set<number>();

  for (const row of rows) {
    const stack = activeWarnsByTarget.get(row.targetId) ?? [];

    if (row.action === "warn") {
      stack.push(row.id);
    } else {
      const cancelledId = stack.shift();
      if (cancelledId !== undefined) {
        cancelled.add(cancelledId);
      }
    }

    activeWarnsByTarget.set(row.targetId, stack);
  }

  return cancelled;
}

const SANCTIONS_PAGE_BUTTON_PREFIX = "sanctions_page_";
const SANCTIONS_PAGE_SIZE = 10;

type SanctionDisplayStatus = "active" | "expired" | "cancelled" | "historical";

function getSanctionDisplayStatuses(
  rows: Array<{
    id: number;
    targetId: string;
    action: string;
    durationMinutes: number | null;
    createdAt: Date;
  }>,
): Map<number, SanctionDisplayStatus> {
  const statuses = new Map<number, SanctionDisplayStatus>();
  const openByTargetAndAction = new Map<
    string,
    Array<{ id: number; active: boolean }>
  >();

  for (const row of [...rows].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  )) {
    const key = `${row.targetId}:${row.action}`;
    const nowActive =
      row.action === "warn" ||
      row.action === "mute" ||
      row.action === "ban"
        ? row.durationMinutes === null ||
          row.createdAt.getTime() + row.durationMinutes * 60 * 1000 > Date.now()
        : false;

    if (row.action === "warn" || row.action === "mute" || row.action === "ban") {
      statuses.set(
        row.id,
        nowActive ? "active" : "expired",
      );
      const openRows = openByTargetAndAction.get(key) ?? [];
      openRows.push({ id: row.id, active: nowActive });
      openByTargetAndAction.set(key, openRows);
      continue;
    }

    if (row.action === "unwarn" || row.action === "unmute" || row.action === "unban") {
      const reversedAction = row.action.slice(2);
      const openRows = openByTargetAndAction.get(
        `${row.targetId}:${reversedAction}`,
      );
      const previous = openRows
        ? [...openRows].reverse().find((candidate) => candidate.active)
        : undefined;
      if (previous) {
        previous.active = false;
        statuses.set(previous.id, "cancelled");
      }
      statuses.set(row.id, "historical");
      continue;
    }

    statuses.set(row.id, "historical");
  }

  return statuses;
}

async function buildSanctionsPage(
  guild: Guild,
  page: number,
  actionFilter: string | null,
  userFilterId: string | null,
) {
  const conditions = [eq(discordSanctionsTable.guildId, guild.id)];

  if (userFilterId) {
    conditions.push(eq(discordSanctionsTable.targetId, userFilterId));
  }

  if (actionFilter) {
    conditions.push(eq(discordSanctionsTable.action, actionFilter));
  }

  // Sans filtre par membre, on masque les sanctions d'annulation
  // (unwarn, unmute, unban) de la liste globale.
  if (!userFilterId && !actionFilter) {
    conditions.push(
      notInArray(
        discordSanctionsTable.action,
        REVERSAL_SANCTION_ACTIONS as unknown as string[],
      ),
    );
  }

  const allSanctions = await db
    .select()
    .from(discordSanctionsTable)
    .where(and(...conditions))
    .orderBy(desc(discordSanctionsTable.createdAt));

  const allGuildSanctions = await db
    .select()
    .from(discordSanctionsTable)
    .where(eq(discordSanctionsTable.guildId, guild.id));
  const sanctionStatuses = getSanctionDisplayStatuses(allGuildSanctions);
  const cancelledWarnIds = new Set(
    [...sanctionStatuses.entries()]
      .filter(([, status]) => status === "cancelled")
      .map(([id]) => id),
  );
  const sanctions = allSanctions.filter(
    (sanction) =>
      !(sanction.action === "warn" && cancelledWarnIds.has(sanction.id)),
  );

  const totalPages = Math.max(
    1,
    Math.ceil(sanctions.length / SANCTIONS_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageItems = sanctions.slice(
    safePage * SANCTIONS_PAGE_SIZE,
    safePage * SANCTIONS_PAGE_SIZE + SANCTIONS_PAGE_SIZE,
  );

  const description =
    pageItems.length > 0
      ? pageItems
          .map((sanction) => {
            const durationText = sanction.durationMinutes
              ? ` • ${sanction.durationMinutes} min`
              : "";
            const timestamp = Math.floor(
              new Date(sanction.createdAt).getTime() / 1000,
            );

            return [
              `**${sanction.action.toUpperCase()}**${durationText} — **${formatSanctionDisplayStatus(sanctionStatuses.get(sanction.id))}** — ID : \`${sanction.id}\``,
              `Membre : ${sanction.targetTag} (\`${sanction.targetId}\`)`,
              `Modérateur : ${sanction.moderatorTag} (\`${sanction.moderatorId}\`)`,
              `Raison : ${sanction.reason}`,
              `Date : <t:${timestamp}:f>`,
            ].join("\n");
          })
          .join("\n\n")
      : "Aucune sanction à afficher.";

  const embed = new EmbedBuilder()
    .setTitle(`Sanctions — ${guild.name}`)
    .setColor(0x3498db)
    .setDescription(description)
    .setFooter({
      text: `Page ${safePage + 1}/${totalPages} — ${sanctions.length} sanction(s)`,
    });

  const encodedAction = actionFilter ?? "";
  const encodedUser = userFilterId ?? "";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `${SANCTIONS_PAGE_BUTTON_PREFIX}${safePage - 1}:${encodedAction}:${encodedUser}`,
      )
      .setLabel("◀ Précédent")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(
        `${SANCTIONS_PAGE_BUTTON_PREFIX}${safePage + 1}:${encodedAction}:${encodedUser}`,
      )
      .setLabel("Suivant ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );

  return {
    embed,
    components: totalPages > 1 ? [row] : [],
    totalCount: sanctions.length,
  };
}

function formatSanctionDisplayStatus(
  status: SanctionDisplayStatus | undefined,
): string {
  switch (status) {
    case "active":
      return "EN COURS";
    case "expired":
      return "EXPIRÉE";
    case "cancelled":
      return "ANNULÉE";
    default:
      return "HISTORIQUE";
  }
}

async function isBotMaintenanceEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ enabled: discordBotMaintenanceTable.enabled })
    .from(discordBotMaintenanceTable)
    .where(eq(discordBotMaintenanceTable.id, 1))
    .limit(1);
  return row?.enabled === 1;
}

async function handleMaintenanceCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette commande est réservée au propriétaire principal du bot.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const mode = interaction.options.getString("mode", true);
  const [maintenanceRow] = await db
    .select({ enabled: discordBotMaintenanceTable.enabled })
    .from(discordBotMaintenanceTable)
    .where(eq(discordBotMaintenanceTable.id, 1))
    .limit(1);
  const maintenanceEnabled = maintenanceRow?.enabled === 1;

  if (mode === "status") {
    await interaction.reply({
      content: maintenanceEnabled
        ? "🛠️ Le mode maintenance est **activé**. Seul le propriétaire principal peut utiliser le bot."
        : "✅ Le mode maintenance est **désactivé**.",
      ephemeral: true,
    });
    return;
  }

  const enabled = mode === "on";
  await db
    .insert(discordBotMaintenanceTable)
    .values({
      id: 1,
      enabled: enabled ? 1 : 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discordBotMaintenanceTable.id,
      set: {
        enabled: enabled ? 1 : 0,
        updatedAt: new Date(),
      },
    });

  await interaction.reply({
    content: enabled
      ? "🛠️ Mode maintenance **activé**. Toutes les commandes sont désormais bloquées sauf pour le propriétaire principal."
      : "✅ Mode maintenance **désactivé**. Les commandes sont de nouveau accessibles.",
    ephemeral: true,
  });
}

async function listSanctions(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const actionFilter = interaction.options.getString("action");
  const userFilter = interaction.options.getUser("user");

  const { embed, components, totalCount } = await buildSanctionsPage(
    guild,
    0,
    actionFilter,
    userFilter?.id ?? null,
  );

  if (totalCount === 0) {
    await interaction.reply("Aucune sanction enregistrée pour le moment.");
    return;
  }

  await interaction.reply({ embeds: [embed], components });
}

async function handleSanctionsPageButton(interaction: ButtonInteraction) {
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) &&
    !(await isBotOwnerInteraction(interaction))
  ) {
    await interaction.reply({
      content: "Cette action est réservée aux membres ayant la permission Administrateur.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    return;
  }

  const payload = interaction.customId.slice(
    SANCTIONS_PAGE_BUTTON_PREFIX.length,
  );
  const [pageRaw, actionRaw, userRaw] = payload.split(":");
  const page = Number.parseInt(pageRaw ?? "0", 10) || 0;

  const { embed, components } = await buildSanctionsPage(
    guild,
    page,
    actionRaw || null,
    userRaw || null,
  );

  await interaction.update({ embeds: [embed], components });
}

async function editSanction(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const id = interaction.options.getInteger("id", true);
  const minutes = interaction.options.getInteger("minutes");
  const newReason = interaction.options.getString("reason");

  if (minutes === null && newReason === null) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Précise au moins une nouvelle durée ou une nouvelle raison.`,
    });
    return;
  }

  const [sanction] = await db
    .select()
    .from(discordSanctionsTable)
    .where(eq(discordSanctionsTable.id, id))
    .limit(1);

  if (!sanction || sanction.guildId !== guild.id) {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}Aucune sanction avec cet identifiant n’a été trouvée sur ce serveur.`,
    });
    return;
  }

  if (minutes !== null && sanction.action !== "mute") {
    await interaction.reply({
      content: `${moderationResultPrefix(guild, false)}La durée ne peut être modifiée que pour une sanction de type mute.`,
    });
    return;
  }

  const updates: Partial<NewDiscordSanction> = {};
  if (newReason !== null) {
    updates.reason = newReason;
  }
  if (minutes !== null) {
    updates.durationMinutes = minutes;
  }

  await db
    .update(discordSanctionsTable)
    .set(updates)
    .where(eq(discordSanctionsTable.id, id));

  if (minutes !== null && sanction.action === "mute") {
    const target = await guild.members
      .fetch(sanction.targetId)
      .catch(() => null);
    if (target?.moderatable) {
      await target.timeout(minutes * 60 * 1000, newReason ?? sanction.reason);
    }
  }

  const fields = [
    {
      name: "Membre",
      value: `${sanction.targetTag}\n\`${sanction.targetId}\``,
      inline: true,
    },
    {
      name: "Modérateur",
      value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
      inline: true,
    },
  ];

  if (newReason !== null) {
    fields.push({ name: "Nouvelle raison", value: newReason, inline: false });
  }
  if (minutes !== null) {
    fields.push({
      name: "Nouvelle durée",
      value: `${minutes} minute(s)`,
      inline: true,
    });
  }

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle(`Sanction modifiée : #${id}`)
      .setColor(0xf39c12)
      .addFields(fields)
      .setTimestamp(),
    "sanctions",
  );

  await interaction.reply({
    content: `${moderationResultPrefix(guild, true)}Sanction #${id} mise à jour.`,
  });
}

// Types de sanctions concernés par /resetsanctions. N'inclut pas les
// annulations (unwarn/unmute/unban) ni le kick, qui n'ont pas été demandés.
const RESETTABLE_SANCTION_ACTIONS = ["warn", "mute", "ban"] as const;
// Sous-ensemble concerné par /resetmuteban.
const RESETTABLE_MUTE_BAN_ACTIONS = ["mute", "ban"] as const;

async function resetSanctionsByActions(
  interaction: ChatInputCommandInteraction,
  actions: readonly string[],
  label: string,
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content:
        "Réinitialisation annulée. Relance la commande avec `confirm: true` pour confirmer.",
    });
    return;
  }

  const matchCondition = and(
    eq(discordSanctionsTable.guildId, guild.id),
    inArray(discordSanctionsTable.action, actions as unknown as string[]),
  );

  const existing = await db
    .select({ id: discordSanctionsTable.id })
    .from(discordSanctionsTable)
    .where(matchCondition);

  if (existing.length === 0) {
    await interaction.reply({
      content: `Aucune sanction ${label} à réinitialiser.`,
    });
    return;
  }

  await db.delete(discordSanctionsTable).where(matchCondition);

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("Sanctions réinitialisées")
      .setColor(0xf39c12)
      .addFields(
        {
          name: "Types réinitialisés",
          value: label,
          inline: true,
        },
        {
          name: "Nombre supprimé",
          value: String(existing.length),
          inline: true,
        },
        {
          name: "Effectué par",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
        },
      )
      .setTimestamp(),
    "sanctions",
  );

  await interaction.reply({
    content: `${existing.length} sanction(s) ${label} réinitialisée(s).`,
  });
}

async function resetSanctions(interaction: ChatInputCommandInteraction) {
  await resetSanctionsByActions(
    interaction,
    RESETTABLE_SANCTION_ACTIONS,
    "warn/mute/ban",
  );
}

async function resetMuteBanSanctions(interaction: ChatInputCommandInteraction) {
  await resetSanctionsByActions(
    interaction,
    RESETTABLE_MUTE_BAN_ACTIONS,
    "mute/ban",
  );
}

const COSMO_CATEGORY_LABELS: Record<string, string> = {
  spam: "Spam",
  harassment: "Insultes / harcèlement",
  inappropriate: "Contenu inapproprié",
  advertising: "Publicité",
  suspicious: "Comportement suspect",
  other: "Autre",
};

const COSMO_STATUS_LABELS: Record<string, string> = {
  new: "Nouveau",
  in_progress: "En cours",
  waiting: "En attente",
  resolved: "Résolu",
  rejected: "Rejeté",
};

const COSMO_STATUS_COLORS: Record<string, number> = {
  new: 0x95a5a6,
  in_progress: 0xf39c12,
  waiting: 0x3498db,
  resolved: 0x2ecc71,
  rejected: 0xe74c3c,
};

const COSMO_PRIORITY_LABELS: Record<string, string> = {
  low: "Faible",
  normal: "Normale",
  high: "Haute",
  critical: "Critique",
};

function buildCosmoReportEmbed(report: {
  id: number;
  reporterTag: string;
  targetTag: string;
  targetId: string;
  category: string;
  description: string;
  evidence: string | null;
  priority: string;
  status: string;
  assignedToTag: string | null;
  createdAt: Date;
}) {
  return new EmbedBuilder()
    .setTitle(`🛡️ Signalement CS-${report.id}`)
    .setColor(COSMO_STATUS_COLORS[report.status] ?? 0x95a5a6)
    .addFields(
      {
        name: "Membre concerné",
        value: `${report.targetTag}\n\`${report.targetId}\``,
        inline: true,
      },
      {
        name: "Catégorie",
        value: COSMO_CATEGORY_LABELS[report.category] ?? report.category,
        inline: true,
      },
      {
        name: "Priorité",
        value: COSMO_PRIORITY_LABELS[report.priority] ?? report.priority,
        inline: true,
      },
      { name: "Auteur", value: report.reporterTag, inline: true },
      {
        name: "Statut",
        value: COSMO_STATUS_LABELS[report.status] ?? report.status,
        inline: true,
      },
      {
        name: "Responsable",
        value: report.assignedToTag ?? "Non attribué",
        inline: true,
      },
      { name: "Description", value: report.description.slice(0, 1024) },
      ...(report.evidence
        ? [{ name: "Preuve / lien", value: report.evidence.slice(0, 1024) }]
        : []),
    )
    .setFooter({
      text: "Les signalements sont confidentiels et ne déclenchent pas automatiquement une sanction.",
    })
    .setTimestamp(report.createdAt);
}

function buildCosmoReportButtons(reportId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COSMO_REPORT_BUTTON_PREFIX}take_${reportId}`)
      .setLabel("Prendre en charge")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COSMO_REPORT_BUTTON_PREFIX}resolve_${reportId}`)
      .setLabel("Résolu")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${COSMO_REPORT_BUTTON_PREFIX}reject_${reportId}`)
      .setLabel("Rejeter")
      .setStyle(ButtonStyle.Danger),
  );
}

async function notifyCosmoReportUpdate(
  client: DiscordClient<boolean>,
  report: {
    id: number;
    reporterId: string;
    status: string;
    priority: string;
    assignedToTag: string | null;
  },
  change: string,
) {
  const reporter = await client.users.fetch(report.reporterId).catch((err) => {
    logger.warn(
      { err, reportId: report.id, reporterId: report.reporterId },
      "Failed to fetch Cosmo report author for DM notification",
    );
    return null;
  });
  if (!reporter) {
    return;
  }

  await reporter
    .send({
      content: [
        `🛡️ Mise à jour de ton signalement **CS-${report.id}**`,
        change,
        "",
        `Statut : **${COSMO_STATUS_LABELS[report.status] ?? report.status}**`,
        `Priorité : **${COSMO_PRIORITY_LABELS[report.priority] ?? report.priority}**`,
        `Responsable : **${report.assignedToTag ?? "Non attribué"}**`,
        "",
        "Ce message est confidentiel. Les détails internes de la modération ne sont pas communiqués.",
      ].join("\n"),
    })
    .catch((err) => {
      logger.warn(
        { err, reportId: report.id, reporterId: report.reporterId },
        "Failed to send Cosmo report update DM",
      );
    });
}

async function handleCosmoReportCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const cooldownKey = `${guild.id}:${interaction.user.id}`;
  const lastReport = COSMO_REPORT_COOLDOWNS.get(cooldownKey) ?? 0;
  if (Date.now() - lastReport < COSMO_REPORT_COOLDOWN_MS) {
    const remaining = Math.ceil(
      (COSMO_REPORT_COOLDOWN_MS - (Date.now() - lastReport)) / 60_000,
    );
    await interaction.reply({
      content: `Tu as déjà envoyé un signalement récemment. Réessaie dans environ ${remaining} minute(s).`,
      ephemeral: true,
    });
    return;
  }

  const target = interaction.options.getUser("user", true);
  if (target.bot || target.id === interaction.user.id) {
    await interaction.reply({
      content: "Tu ne peux pas signaler un bot ou toi-même.",
      ephemeral: true,
    });
    return;
  }

  const resources = await ensureCosmoResources(guild);
  const [report] = await db
    .insert(discordReportsTable)
    .values({
      guildId: guild.id,
      reporterId: interaction.user.id,
      reporterTag: interaction.user.tag,
      targetId: target.id,
      targetTag: target.tag,
      category: interaction.options.getString("category", true),
      description: interaction.options.getString("description", true),
      evidence: interaction.options.getString("evidence"),
      channelId: resources.reportsChannelId,
    })
    .returning();

  if (!report) {
    throw new Error("Le signalement n'a pas pu être enregistré.");
  }

  COSMO_REPORT_COOLDOWNS.set(cooldownKey, Date.now());
  await advanceTriggeredMissions(guild, interaction.user.id, "report").catch(
    (err) =>
      logger.error(
        { err, guildId: guild.id, userId: interaction.user.id },
        "Failed to advance report missions",
      ),
  );
  const reportChannel = guild.channels.cache.get(resources.reportsChannelId);
  if (reportChannel?.type === ChannelType.GuildText) {
    await reportChannel.send({
      embeds: [buildCosmoReportEmbed(report)],
      components: [buildCosmoReportButtons(report.id)],
      allowedMentions: { parse: [] },
    });
  }

  await notifyCosmoReportUpdate(
    interaction.client,
    report,
    "Ton signalement a bien été reçu et sera examiné confidentiellement.",
  );

  await interaction.reply({
    content: `✅ Ton signalement **CS-${report.id}** a été transmis à la modération. Il sera examiné confidentiellement.`,
    ephemeral: true,
  });
}

async function getCosmoReport(guildId: string, reportId: number) {
  const [report] = await db
    .select()
    .from(discordReportsTable)
    .where(
      and(eq(discordReportsTable.guildId, guildId), eq(discordReportsTable.id, reportId)),
    )
    .limit(1);
  return report;
}

async function handleCosmoReportsCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!(await hasCosmoModeratorAccess(interaction))) {
    await interaction.reply({
      content: "Cette commande est réservée à la modération.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const conditions = [eq(discordReportsTable.guildId, guild.id)];
  const status = interaction.options.getString("status");
  const priority = interaction.options.getString("priority");
  if (status) conditions.push(eq(discordReportsTable.status, status));
  if (priority) conditions.push(eq(discordReportsTable.priority, priority));

  const reports = await db
    .select()
    .from(discordReportsTable)
    .where(and(...conditions))
    .orderBy(desc(discordReportsTable.createdAt))
    .limit(15);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🛡️ Signalements Cosmo Shield")
        .setColor(0x3498db)
        .setDescription(
          reports.length > 0
            ? reports
                .map(
                  (report) =>
                    `**CS-${report.id}** — ${COSMO_STATUS_LABELS[report.status] ?? report.status} / ${COSMO_PRIORITY_LABELS[report.priority] ?? report.priority}\nCible : ${report.targetTag} • ${COSMO_CATEGORY_LABELS[report.category] ?? report.category}\nCréé ${formatDate(report.createdAt)}`,
                )
                .join("\n\n")
            : "Aucun signalement ne correspond à ces filtres.",
        )
        .setFooter({ text: "Utilise /signalement pour traiter un dossier." }),
    ],
    ephemeral: true,
  });
}

async function handleCosmoReportActionCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!(await hasCosmoModeratorAccess(interaction))) {
    await interaction.reply({
      content: "Cette commande est réservée à la modération.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  const reportId = interaction.options.getInteger("id", true);
  const report = await getCosmoReport(guild.id, reportId);
  if (!report) {
    await interaction.reply({
      content: `Le signalement CS-${reportId} est introuvable.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "voir") {
    const notes = await db
      .select()
      .from(discordReportNotesTable)
      .where(eq(discordReportNotesTable.reportId, reportId))
      .orderBy(asc(discordReportNotesTable.createdAt));
    const notesText =
      notes.length > 0
        ? notes
            .map(
              (note) =>
                `• **${note.authorTag}** ${formatDate(note.createdAt)}\n${note.content}`,
            )
            .join("\n\n")
        : "Aucune note interne.";

    await interaction.reply({
      embeds: [
        buildCosmoReportEmbed(report).addFields({
          name: "Notes internes",
          value: notesText.slice(0, 1024),
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "note") {
    await db.insert(discordReportNotesTable).values({
      reportId,
      authorId: interaction.user.id,
      authorTag: interaction.user.tag,
      content: interaction.options.getString("content", true),
    });
    await interaction.reply({
      content: `✅ Note interne ajoutée à CS-${reportId}.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "prendre") {
    await db
      .update(discordReportsTable)
      .set({
        status: "in_progress",
        assignedToId: interaction.user.id,
        assignedToTag: interaction.user.tag,
        updatedAt: new Date(),
      })
      .where(eq(discordReportsTable.id, reportId));
    await notifyCosmoReportUpdate(
      interaction.client,
      {
        ...report,
        status: "in_progress",
        assignedToTag: interaction.user.tag,
      },
      `Le signalement est maintenant pris en charge par **${interaction.user.tag}**.`,
    );
    await interaction.reply({
      content: `✅ Tu prends en charge CS-${reportId}.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "priorite") {
    const priority = interaction.options.getString("priority", true);
    await db
      .update(discordReportsTable)
      .set({ priority, updatedAt: new Date() })
      .where(eq(discordReportsTable.id, reportId));
    await notifyCosmoReportUpdate(
      interaction.client,
      { ...report, priority },
      `La priorité du signalement a été modifiée : **${COSMO_PRIORITY_LABELS[priority] ?? priority}**.`,
    );
    await interaction.reply({
      content: `✅ Priorité de CS-${reportId} définie sur ${COSMO_PRIORITY_LABELS[priority]}.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "statut") {
    const nextStatus = interaction.options.getString("status", true);
    await db
      .update(discordReportsTable)
      .set({
        status: nextStatus,
        updatedAt: new Date(),
        closedAt:
          nextStatus === "resolved" || nextStatus === "rejected"
            ? new Date()
            : null,
      })
      .where(eq(discordReportsTable.id, reportId));
    await notifyCosmoReportUpdate(
      interaction.client,
      { ...report, status: nextStatus },
      `Le statut du signalement a évolué vers **${COSMO_STATUS_LABELS[nextStatus] ?? nextStatus}**.`,
    );
    await interaction.reply({
      content: `✅ Statut de CS-${reportId} : ${COSMO_STATUS_LABELS[nextStatus]}.`,
      ephemeral: true,
    });
    return;
  }

  await db.insert(discordReportNotesTable).values({
    reportId,
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    content: `Clôture : ${interaction.options.getString("reason", true)}`,
  });
  await db
    .update(discordReportsTable)
    .set({ status: "resolved", updatedAt: new Date(), closedAt: new Date() })
    .where(eq(discordReportsTable.id, reportId));
  await notifyCosmoReportUpdate(
    interaction.client,
    { ...report, status: "resolved" },
    `Le signalement a été clôturé : **${interaction.options.getString("reason", true)}**.`,
  );
  await interaction.reply({
    content: `✅ Signalement CS-${reportId} clôturé.`,
    ephemeral: true,
  });
}

async function handleCosmoReportButton(interaction: ButtonInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette action doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const moderator = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  const resources = await ensureCosmoResources(interaction.guild);
  const guildSettings = await getGuildSettings(interaction.guild.id);
  if (
    interaction.user.id !== BOT_OWNER_ID &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) &&
    !moderator?.roles.cache.has(resources.moderatorRoleId) &&
    !(
      guildSettings.roleIds.warn &&
      moderator?.roles.cache.has(guildSettings.roleIds.warn)
    )
  ) {
    await interaction.reply({
      content: "Cette action est réservée à la modération.",
      ephemeral: true,
    });
    return;
  }

  const payload = interaction.customId.slice(COSMO_REPORT_BUTTON_PREFIX.length);
  const [action, idText] = payload.split("_");
  const reportId = Number(idText);
  if (!Number.isInteger(reportId)) {
    await interaction.reply({
      content: "Signalement invalide.",
      ephemeral: true,
    });
    return;
  }

  const report = await getCosmoReport(interaction.guild.id, reportId);
  if (!report) {
    await interaction.reply({
      content: "Signalement introuvable.",
      ephemeral: true,
    });
    return;
  }

  const nextStatus =
    action === "take"
      ? "in_progress"
      : action === "reject"
        ? "rejected"
        : "resolved";
  await db
    .update(discordReportsTable)
    .set({
      status: nextStatus,
      assignedToId: interaction.user.id,
      assignedToTag: interaction.user.tag,
      updatedAt: new Date(),
      closedAt:
        nextStatus === "resolved" || nextStatus === "rejected"
          ? new Date()
          : null,
    })
    .where(eq(discordReportsTable.id, reportId));

  await notifyCosmoReportUpdate(
    interaction.client,
    {
      ...report,
      status: nextStatus,
      assignedToTag: interaction.user.tag,
    },
    nextStatus === "in_progress"
      ? `Le signalement est maintenant pris en charge par **${interaction.user.tag}**.`
      : nextStatus === "resolved"
        ? "Le signalement a été marqué comme résolu."
        : "Le signalement a été rejeté.",
  );

  await interaction.update({
    embeds: [
      buildCosmoReportEmbed({
        ...report,
        status: nextStatus,
        assignedToTag: interaction.user.tag,
      }),
    ],
    components:
      nextStatus === "in_progress" ? [buildCosmoReportButtons(reportId)] : [],
  });
}

async function handleCosmoMissionsCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  const activeMissionConditions = and(
    eq(discordMissionsTable.guildId, guild.id),
    eq(discordMissionsTable.status, "active"),
    gt(discordMissionsTable.endsAt, new Date()),
  );

  if (subcommand === "liste") {
    const missions = await db
      .select()
      .from(discordMissionsTable)
      .where(activeMissionConditions)
      .orderBy(asc(discordMissionsTable.endsAt))
      .limit(15);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎯 Cosmo Missions")
          .setColor(0x3498db)
          .setDescription(
            missions.length > 0
              ? missions
                  .map(
                    (mission) =>
                      `**CM-${mission.id} — ${mission.title}**\n${mission.description}\nObjectif : ${mission.targetCount} • Récompense : ${mission.rewardXp} XP • Fin ${formatDate(mission.endsAt)}`,
                  )
                  .join("\n\n")
              : "Aucune mission active pour le moment.",
          ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "progression") {
    const missions = await db
      .select({
        mission: discordMissionsTable,
        progress: discordMissionProgressTable.progress,
        rewardedAt: discordMissionProgressTable.rewardedAt,
      })
      .from(discordMissionsTable)
      .leftJoin(
        discordMissionProgressTable,
        and(
          eq(discordMissionProgressTable.missionId, discordMissionsTable.id),
          eq(discordMissionProgressTable.userId, interaction.user.id),
        ),
      )
      .where(
        activeMissionConditions,
      )
      .orderBy(asc(discordMissionsTable.endsAt));
    await interaction.reply({
      content:
        missions.length > 0
          ? missions
              .map(
                ({ mission, progress, rewardedAt }) =>
                  `**CM-${mission.id} ${mission.title}** — ${progress ?? 0}/${mission.targetCount}${rewardedAt ? " ✅" : ""}`,
              )
              .join("\n")
          : "Aucune mission active.",
      ephemeral: true,
    });
    return;
  }

  const rows = await db
    .select({
      userId: discordMissionProgressTable.userId,
      progress: discordMissionProgressTable.progress,
    })
    .from(discordMissionProgressTable)
    .where(eq(discordMissionProgressTable.guildId, guild.id))
    .orderBy(desc(discordMissionProgressTable.progress))
    .limit(10);
  await interaction.reply({
    content:
      rows.length > 0
        ? rows
            .map(
              (row, index) =>
                `${index + 1}. <@${row.userId}> — ${row.progress} progression(s)`,
            )
            .join("\n")
        : "Le classement des missions est encore vide.",
    ephemeral: true,
  });
}

async function handleCosmoMissionCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }
  const missionId = interaction.options.getInteger("id", true);
  const [mission] = await db
    .select()
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.id, missionId),
        eq(discordMissionsTable.guildId, guild.id),
      ),
    )
    .limit(1);

  if (!mission) {
    await interaction.reply({
      content: `Mission CM-${missionId} introuvable.`,
      ephemeral: true,
    });
    return;
  }

  const [progress] = await db
    .select()
    .from(discordMissionProgressTable)
    .where(
      and(
        eq(discordMissionProgressTable.missionId, missionId),
        eq(discordMissionProgressTable.userId, interaction.user.id),
      ),
    )
    .limit(1);

  const isActive =
    mission.status === "active" && mission.endsAt.getTime() > Date.now();
  const embed = new EmbedBuilder()
    .setTitle(`🎯 CM-${mission.id} — ${mission.title}`)
    .setDescription(mission.description)
    .setColor(isActive ? 0x3498db : 0x7f8c8d)
    .addFields(
      {
        name: "Statut",
        value: isActive ? "Active" : mission.status === "active" ? "Expirée" : mission.status,
        inline: true,
      },
      {
        name: "Objectif",
        value: String(mission.targetCount),
        inline: true,
      },
      {
        name: "Récompense",
        value: `${mission.rewardXp} XP`,
        inline: true,
      },
      {
        name: "Ta progression",
        value: `${progress?.progress ?? 0}/${mission.targetCount}${progress?.rewardedAt ? " ✅ récompensée" : ""}`,
        inline: true,
      },
      { name: "Fin", value: formatDate(mission.endsAt), inline: true },
      { name: "Créée par", value: mission.createdByTag, inline: true },
    )
    .setTimestamp(mission.createdAt);

  await interaction.reply({
    embeds: [embed],
    components: isActive
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${COSMO_MISSION_JOIN_PREFIX}${mission.id}`)
              .setLabel(progress ? "Déjà inscrit" : "Participer")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(Boolean(progress)),
          ),
        ]
      : [],
    ephemeral: true,
  });
}

async function handleCosmoMissionJoinButton(interaction: ButtonInteraction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette action doit être utilisée sur un serveur.",
      ephemeral: true,
    });
    return;
  }
  const missionId = Number(
    interaction.customId.slice(COSMO_MISSION_JOIN_PREFIX.length),
  );
  const [mission] = await db
    .select()
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.id, missionId),
        eq(discordMissionsTable.guildId, interaction.guild.id),
        eq(discordMissionsTable.status, "active"),
        gt(discordMissionsTable.endsAt, new Date()),
      ),
    )
    .limit(1);
  if (!mission) {
    await interaction.reply({
      content: "Cette mission n’est plus active.",
      ephemeral: true,
    });
    return;
  }

  await db
    .insert(discordMissionProgressTable)
    .values({
      missionId,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
    })
    .onConflictDoNothing();
  await interaction.reply({
    content: `✅ Tu participes maintenant à **${mission.title}**.`,
    ephemeral: true,
  });
}

async function handleCosmoAdminCommand(
  interaction: ChatInputCommandInteraction,
) {
  const subcommand = interaction.options.getSubcommand();
  if (!interaction.guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "setup") {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) &&
      !(await isBotOwnerInteraction(interaction))
    ) {
      await interaction.reply({
        content: "La configuration Cosmo est réservée aux administrateurs.",
        ephemeral: true,
      });
      return;
    }
    const resources = await ensureCosmoResources(interaction.guild);
    await interaction.reply({
      content: [
        "✅ Cosmo configuré.",
        `• Signalements : <#${resources.reportsChannelId}>`,
        `• Missions : <#${resources.missionsChannelId}>`,
        `• Missions globales du lundi : <#${resources.globalMissionsChannelId}>`,
        `• Rôle modération : <@&${resources.moderatorRoleId}>`,
        `• Rôle Gardien : <@&${resources.guardianRoleId}>`,
        "",
        "Le rôle @Cosmo Gardien récompense l’implication dans les missions Cosmo : chaque mission validée donne de l’XP Gardien et peut attribuer ce rôle. Le niveau Gardien est visible avec `*profile` et `*badge`.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "mission-publish") {
    if (!isStrictBotOwnerInteraction(interaction)) {
      await interaction.reply({
        content: "Cette commande est réservée au propriétaire principal du bot.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const { weekStart } = getCurrentWeeklyMissionPeriod();
    await publishGlobalMissionsForGuild(
      interaction.client,
      interaction.guild,
      weekStart,
      true,
    );
    const resources = await ensureCosmoResources(interaction.guild);
    await interaction.editReply(
      `✅ Les missions globales ont été publiées dans <#${resources.globalMissionsChannelId}>.`,
    );
    return;
  }

  if (!(await hasCosmoModeratorAccess(interaction))) {
    await interaction.reply({
      content: "Cette action est réservée à la modération Cosmo.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "mission-create") {
    const days =
      interaction.options.getInteger("days") ?? COSMO_DEFAULT_MISSION_DAYS;
    const targetCount = interaction.options.getInteger("target") ?? 1;
    const rewardXp = interaction.options.getInteger("reward_xp") ?? 100;
    const [mission] = await db
      .insert(discordMissionsTable)
      .values({
        guildId: interaction.guild.id,
        title: interaction.options.getString("title", true),
        description: interaction.options.getString("description", true),
        triggerEvent:
          interaction.options.getString("trigger") ?? "manual",
        targetCount,
        rewardXp,
        endsAt: new Date(Date.now() + days * 86_400_000),
        createdById: interaction.user.id,
        createdByTag: interaction.user.tag,
      })
      .returning();
    if (!mission) {
      throw new Error("La mission n'a pas pu être créée.");
    }

    const resources = await ensureCosmoResources(interaction.guild);
    const channel = interaction.guild.channels.cache.get(
      resources.missionsChannelId,
    );
    if (channel?.type === ChannelType.GuildText) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🎯 CM-${mission.id} — ${mission.title}`)
            .setDescription(mission.description)
            .setColor(0x3498db)
            .addFields(
              {
                name: "Objectif",
                value: String(mission.targetCount),
                inline: true,
              },
              {
                name: "Récompense",
                value: `${mission.rewardXp} XP`,
                inline: true,
              },
              {
                name: "Déclencheur",
                value: mission.triggerEvent,
                inline: true,
              },
              { name: "Fin", value: formatDate(mission.endsAt), inline: true },
            )
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${COSMO_MISSION_JOIN_PREFIX}${mission.id}`)
              .setLabel("Participer")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    }
    await interaction.reply({
      content: `✅ Mission CM-${mission.id} créée dans <#${resources.missionsChannelId}>.`,
      ephemeral: true,
    });
    return;
  }

  const missionId = interaction.options.getInteger("id", true);
  const [mission] = await db
    .select()
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.id, missionId),
        eq(discordMissionsTable.guildId, interaction.guild.id),
      ),
    )
    .limit(1);
  if (!mission) {
    await interaction.reply({
      content: `Mission CM-${missionId} introuvable.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "mission-close") {
    await db
      .update(discordMissionsTable)
      .set({ status: "closed" })
      .where(eq(discordMissionsTable.id, missionId));
    await interaction.reply({
      content: `✅ Mission CM-${missionId} fermée.`,
      ephemeral: true,
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const progress = interaction.options.getInteger("progress", true);
  const nextProgress = Math.min(progress, mission.targetCount);
  const [existingProgress] = await db
    .select()
    .from(discordMissionProgressTable)
    .where(
      and(
        eq(discordMissionProgressTable.missionId, missionId),
        eq(discordMissionProgressTable.userId, user.id),
      ),
    )
    .limit(1);
  const wasRewarded = Boolean(existingProgress?.rewardedAt);
  const isComplete = nextProgress >= mission.targetCount;
  const now = new Date();
  if (existingProgress) {
    await db
      .update(discordMissionProgressTable)
      .set({
        progress: nextProgress,
        completedAt: isComplete ? now : null,
        rewardedAt: isComplete && !wasRewarded ? now : existingProgress.rewardedAt,
      })
      .where(eq(discordMissionProgressTable.id, existingProgress.id));
  } else {
    await db.insert(discordMissionProgressTable).values({
      missionId,
      guildId: interaction.guild.id,
      userId: user.id,
      progress: nextProgress,
      completedAt: isComplete ? now : null,
      rewardedAt: isComplete ? now : null,
    });
  }
  if (isComplete && !wasRewarded && mission.rewardXp > 0) {
    await grantBonusXp(interaction.guild, user.id, mission.rewardXp);
  }
  if (isComplete && !wasRewarded) {
    const resources = await ensureCosmoResources(interaction.guild);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member && !member.roles.cache.has(resources.guardianRoleId)) {
      await member.roles
        .add(resources.guardianRoleId, `Mission Cosmo CM-${mission.id} validée`)
        .catch((err) => {
          logger.warn(
            { err, guildId: interaction.guild?.id, userId: user.id },
            "Failed to grant Cosmo Guardian role",
          );
        });
    }
  }
  await interaction.reply({
    content: `✅ Progression de <@${user.id}> pour CM-${missionId} définie à ${nextProgress}/${mission.targetCount}${isComplete ? ` et récompensée avec ${mission.rewardXp} XP.` : "."}`,
    ephemeral: true,
  });
}

async function reconcileCosmoMissions(): Promise<void> {
  const expiredMissions = await db
    .select({ id: discordMissionsTable.id })
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.status, "active"),
        lt(discordMissionsTable.endsAt, new Date()),
      ),
    );

  if (expiredMissions.length === 0) {
    return;
  }

  await db
    .update(discordMissionsTable)
    .set({ status: "closed" })
    .where(
      and(
        eq(discordMissionsTable.status, "active"),
        lt(discordMissionsTable.endsAt, new Date()),
      ),
    );

  logger.info(
    { closed: expiredMissions.length },
    "Expired Cosmo missions reconciled",
  );
}

async function handleCustomRoleCommand(
  interaction: ChatInputCommandInteraction,
) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "menu") {
    await showCustomRoleMenu(interaction);
    return;
  }

  if (subcommand === "list") {
    await listCustomRoles(interaction);
    return;
  }
}

// --- Commandes animateurs ---

// Récupère le salon fixe de /announce et /poll (ANNOUNCE_POLL_CHANNEL_ID) et
// vérifie que le bot peut bien y écrire.
async function resolveAnnouncePollChannel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<TextChannel | null> {
  const settings = await getGuildSettings(guild.id);
  const channelId = settings.channelIds.announcePoll;
  if (!channelId) {
    await interaction.reply({
      content:
        "Aucun salon n’est configuré pour les annonces et sondages. Utilise `*serverconfig set channel.announcePoll <id>`.",
      ephemeral: true,
    });
    return null;
  }
  const channel = await guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.reply({
      content: "Le salon configuré pour cette commande est introuvable ou n’est plus valide.",
      ephemeral: true,
    });
    return null;
  }

  const botMember = guild.members.me;

  if (
    !botMember
      ?.permissionsIn(channel as TextChannel)
      .has(PermissionFlagsBits.SendMessages)
  ) {
    await interaction.reply({
      content: "Je n’ai pas la permission d’envoyer des messages dans ce salon.",
      ephemeral: true,
    });
    return null;
  }

  return channel as TextChannel;
}

async function handleAnnounceCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const targetChannel = await resolveAnnouncePollChannel(interaction, guild);
  if (!targetChannel) {
    return;
  }

  const message = interaction.options.getString("message", true);
  const title = interaction.options.getString("title");
  const role = interaction.options.getRole("role");

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(message)
    .setFooter({ text: `Annoncé par ${interaction.user.tag}` })
    .setTimestamp();

  if (title) {
    embed.setTitle(title);
  }

  await targetChannel.send({
    content: role ? `${role}` : undefined,
    embeds: [embed],
    allowedMentions: role ? { roles: [role.id] } : { parse: [] },
  });

  await interaction.reply({
    content: `✅ Annonce envoyée dans <#${targetChannel.id}>.`,
    ephemeral: true,
  });
}

const POLL_NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

async function handlePollCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const targetChannel = await resolveAnnouncePollChannel(interaction, guild);
  if (!targetChannel) {
    return;
  }

  const question = interaction.options.getString("question", true);
  const options = [1, 2, 3, 4, 5]
    .map((n) => interaction.options.getString(`option${n}`))
    .filter((option): option is string => Boolean(option));

  const description = options
    .map((option, index) => `${POLL_NUMBER_EMOJIS[index]} ${option}`)
    .join("\n\n");

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${question}`)
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `Sondage lancé par ${interaction.user.tag}` })
    .setTimestamp();

  const message = await targetChannel.send({ embeds: [embed] });

  for (let index = 0; index < options.length; index++) {
    await message.react(POLL_NUMBER_EMOJIS[index]!).catch((err) => {
      logger.error({ err, messageId: message.id }, "Failed to react to poll");
    });
  }

  const durationMinutes = interaction.options.getInteger("duration", true);

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("📊 Sondage créé")
      .setColor(0x5865f2)
      .addFields(
        { name: "Question", value: question },
        {
          name: "Choix",
          value: options
            .map((option, index) => `${POLL_NUMBER_EMOJIS[index]} ${option}`)
            .join("\n"),
        },
        { name: "Salon", value: `<#${targetChannel.id}>`, inline: true },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
        { name: "Message", value: `\`${message.id}\``, inline: true },
        { name: "Durée", value: `${durationMinutes} minute(s)`, inline: true },
      )
      .setTimestamp(),
    "polls",
  );

  await interaction.reply({
    content: `✅ Sondage envoyé dans <#${targetChannel.id}>.`,
    ephemeral: true,
  });

  setTimeout(
    () => {
      closePoll(guild, targetChannel, message.id, question, options).catch(
        (err) => {
          logger.error({ err, messageId: message.id }, "Failed to close poll");
        },
      );
    },
    durationMinutes * 60 * 1000,
  );
}

async function closePoll(
  guild: Guild,
  channel: TextChannel,
  messageId: string,
  question: string,
  options: string[],
) {
  const message = await channel.messages.fetch(messageId).catch(() => null);

  if (!message) {
    return;
  }

  const counts = await Promise.all(
    options.map(async (_option, index) => {
      const reaction = message.reactions.cache.get(POLL_NUMBER_EMOJIS[index]!);
      if (!reaction) {
        return 0;
      }
      const users = await reaction.users.fetch().catch(() => null);
      // On exclut la réaction initiale du bot du décompte.
      return users ? users.filter((user) => !user.bot).size : 0;
    }),
  );

  const maxVotes = Math.max(...counts, 0);
  const winnerIndexes =
    maxVotes > 0
      ? counts.reduce<number[]>((acc, count, index) => {
          if (count === maxVotes) acc.push(index);
          return acc;
        }, [])
      : [];

  const resultDescription = options
    .map((option, index) => {
      const marker = winnerIndexes.includes(index) ? " 🏆" : "";
      return `${POLL_NUMBER_EMOJIS[index]} ${option} — **${counts[index]}** vote(s)${marker}`;
    })
    .join("\n\n");

  const resultEmbed = new EmbedBuilder()
    .setTitle(`📊 ${question} — Sondage clos`)
    .setColor(0x95a5a6)
    .setDescription(resultDescription)
    .setFooter({ text: "Ce sondage est terminé." })
    .setTimestamp();

  await message.edit({ embeds: [resultEmbed] }).catch((err) => {
    logger.error({ err, messageId }, "Failed to edit closed poll message");
  });

  const winnerLabel =
    winnerIndexes.length === 0
      ? "Aucun vote."
      : winnerIndexes.length === 1
        ? `**${options[winnerIndexes[0]!]}** (${maxVotes} vote(s))`
        : `Égalité entre ${winnerIndexes.map((i) => `**${options[i]!}**`).join(", ")} (${maxVotes} vote(s) chacun)`;

  await channel
    .send(`📊 Le sondage **${question}** est clos ! Résultat : ${winnerLabel}`)
    .catch((err) => {
      logger.error({ err, messageId }, "Failed to announce poll results");
    });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("📊 Sondage clos")
      .setColor(0x95a5a6)
      .addFields(
        { name: "Question", value: question },
        { name: "Résultat", value: winnerLabel },
        { name: "Message", value: `\`${messageId}\``, inline: true },
      )
      .setTimestamp(),
    "polls",
  );
}

// --- Mini-jeux animateurs ---

// Attend le premier message d'un salon qui valide `isCorrect`, pendant
// `durationMs`. Retourne ce message, ou `null` si personne n'a trouvé à
// temps. Utilisé par /guessnumber et /quickmath.
function runFirstAnswerGame(
  channel: TextChannel,
  options: {
    isCorrect: (content: string) => boolean;
    durationMs: number;
  },
): Promise<Message | null> {
  return new Promise((resolve) => {
    const collector = channel.createMessageCollector({
      filter: (candidate) =>
        !candidate.author.bot && options.isCorrect(candidate.content.trim()),
      max: 1,
      time: options.durationMs,
    });

    collector.on("collect", (message) => {
      resolve(message);
    });

    collector.on("end", (collected) => {
      if (collected.size === 0) {
        resolve(null);
      }
    });
  });
}

const FIRST_REACT_EMOJI = "⚡";

async function handleFirstReactCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild || !interaction.channel || !("send" in interaction.channel)) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const messageText = interaction.options.getString("message", true);
  const durationSeconds = interaction.options.getInteger("duration") ?? 60;
  const channel = interaction.channel as TextChannel;

  await interaction.reply({
    content: `⚡ **Premier arrivé, premier servi !**\n${messageText}\n\nRéagis avec ${FIRST_REACT_EMOJI} le plus vite possible ! (${durationSeconds}s)`,
  });

  const message = await interaction.fetchReply();
  await message.react(FIRST_REACT_EMOJI).catch((err) => {
    logger.error({ err, messageId: message.id }, "Failed to react to firstreact message");
  });

  const collector = message.createReactionCollector({
    filter: (reaction, user) =>
      reaction.emoji.name === FIRST_REACT_EMOJI && !user.bot,
    max: 1,
    time: durationSeconds * 1000,
  });

  collector.on("collect", async (_reaction, user) => {
    await channel
      .send(`🎉 ${user} a été le plus rapide !`)
      .catch((err) => {
        logger.error({ err }, "Failed to announce firstreact winner");
      });

    await logToGuild(
      interaction.guild!,
      new EmbedBuilder()
        .setTitle("⚡ Firstreact — Résultat")
        .setColor(0x2ecc71)
        .addFields(
          { name: "Message", value: messageText },
          {
            name: "Gagnant",
            value: `${user.tag}\n\`${user.id}\``,
            inline: true,
          },
          {
            name: "Animateur",
            value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
            inline: true,
          },
        )
        .setTimestamp(),
      "games",
    );
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      await channel
        .send("⏱️ Personne n'a réagi à temps.")
        .catch((err) => {
          logger.error({ err }, "Failed to announce firstreact timeout");
        });

      await logToGuild(
        interaction.guild!,
        new EmbedBuilder()
          .setTitle("⚡ Firstreact — Personne n'a réagi")
          .setColor(0x95a5a6)
          .addFields(
            { name: "Message", value: messageText },
            {
              name: "Animateur",
              value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
              inline: true,
            },
          )
          .setTimestamp(),
        "games",
      );
    }
  });
}

async function handleGuessNumberCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild || !interaction.channel || !("send" in interaction.channel)) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const min = interaction.options.getInteger("min", true);
  const max = interaction.options.getInteger("max", true);

  if (min >= max) {
    await interaction.reply({
      content: "La borne minimale doit être inférieure à la borne maximale.",
      ephemeral: true,
    });
    return;
  }

  const durationSeconds = interaction.options.getInteger("duration") ?? 60;
  const secretNumber = min + Math.floor(Math.random() * (max - min + 1));
  const channel = interaction.channel as TextChannel;

  await interaction.reply(
    `🔢 **Devine le nombre !** J'ai choisi un nombre entre **${min}** et **${max}**. Réponds directement dans ce salon, vous avez ${durationSeconds} secondes !`,
  );

  // Indice automatique à la moitié du temps imparti : parité + la moitié
  // de l'intervalle dans laquelle se trouve le nombre.
  const half = min + (max - min) / 2;
  const hintTimeout = setTimeout(() => {
    channel
      .send(
        [
          "💡 **Indice !**",
          `Le nombre est **${secretNumber % 2 === 0 ? "pair" : "impair"}**.`,
          `Il se trouve dans la moitié **${secretNumber <= half ? "basse" : "haute"}** de l'intervalle (entre ${secretNumber <= half ? min : Math.ceil(half)} et ${secretNumber <= half ? Math.floor(half) : max}).`,
        ].join("\n"),
      )
      .catch((err) => {
        logger.error({ err }, "Failed to send guessnumber hint");
      });
  }, Math.floor((durationSeconds * 1000) / 2));

  const winnerMessage = await runFirstAnswerGame(channel, {
    isCorrect: (content) => Number.parseInt(content, 10) === secretNumber,
    durationMs: durationSeconds * 1000,
  });

  clearTimeout(hintTimeout);

  if (winnerMessage) {
    await channel.send(
      `🎉 Bravo ${winnerMessage.author} ! Le nombre était bien **${secretNumber}**.`,
    );
  } else {
    await channel.send(
      `⏱️ Personne n'a trouvé à temps. Le nombre était **${secretNumber}**.`,
    );
  }

  await logToGuild(
    interaction.guild!,
    new EmbedBuilder()
      .setTitle("🔢 Guessnumber — Résultat")
      .setColor(winnerMessage ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: "Intervalle", value: `${min} — ${max}`, inline: true },
        { name: "Nombre secret", value: String(secretNumber), inline: true },
        {
          name: "Gagnant",
          value: winnerMessage
            ? `${winnerMessage.author.tag}\n\`${winnerMessage.author.id}\``
            : "Personne",
        },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

async function handleQuickMathCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guild || !interaction.channel || !("send" in interaction.channel)) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const durationSeconds = interaction.options.getInteger("duration") ?? 30;
  const a = 1 + Math.floor(Math.random() * 50);
  const b = 1 + Math.floor(Math.random() * 50);
  const operators = ["+", "-", "×"] as const;
  const operator = operators[Math.floor(Math.random() * operators.length)]!;
  const answer = operator === "+" ? a + b : operator === "-" ? a - b : a * b;
  const channel = interaction.channel as TextChannel;

  await interaction.reply(
    `🧮 **Calcul mental !** Combien font **${a} ${operator} ${b}** ? Réponds directement dans ce salon, vous avez ${durationSeconds} secondes !`,
  );

  const winnerMessage = await runFirstAnswerGame(channel, {
    isCorrect: (content) => Number.parseInt(content, 10) === answer,
    durationMs: durationSeconds * 1000,
  });

  if (winnerMessage) {
    await channel.send(
      `🎉 Bravo ${winnerMessage.author} ! La réponse était bien **${answer}**.`,
    );
  } else {
    await channel.send(
      `⏱️ Personne n'a trouvé à temps. La réponse était **${answer}**.`,
    );
  }

  await logToGuild(
    interaction.guild!,
    new EmbedBuilder()
      .setTitle("🧮 Quickmath — Résultat")
      .setColor(winnerMessage ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: "Calcul", value: `${a} ${operator} ${b}`, inline: true },
        { name: "Réponse", value: String(answer), inline: true },
        {
          name: "Gagnant",
          value: winnerMessage
            ? `${winnerMessage.author.tag}\n\`${winnerMessage.author.id}\``
            : "Personne",
        },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

// --- Roulette & tirage au sort (animateurs, carte blanche) ---
// Système de paris partagé : bouton "Participer" -> formulaire (couleur +
// numéro) -> 30 secondes pour rejoindre -> tirage.

const ROULETTE_RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

function rouletteColor(number: number): "vert" | "rouge" | "noir" {
  if (number === 0) return "vert";
  return ROULETTE_RED_NUMBERS.has(number) ? "rouge" : "noir";
}

const ROULETTE_COLOR_EMOJI: Record<string, string> = {
  vert: "🟢",
  rouge: "🔴",
  noir: "⚫",
};

const CNDRAW_JOIN_PREFIX = "cndraw_join_";
const CNDRAW_MODAL_PREFIX = "cndraw_modal_";
const CNDRAW_JOIN_DURATION_MS = 30_000;

type ColorNumberBet = {
  color: "rouge" | "noir" | "vert" | null;
  number: number | null;
};

type ColorNumberDrawState = {
  bets: Map<string, ColorNumberBet>;
  locked: boolean;
};

// Parties de paris couleur/numéro en cours, indexées par ID du message.
const ACTIVE_COLOR_NUMBER_DRAWS = new Map<string, ColorNumberDrawState>();

function buildColorNumberJoinRow(token: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CNDRAW_JOIN_PREFIX}${token}`)
      .setLabel(disabled ? "Paris clos" : "🎯 Participer")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function buildColorNumberBetModal(messageId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${CNDRAW_MODAL_PREFIX}${messageId}`)
    .setTitle("Placer un pari")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("Couleur : rouge, noir ou vert (optionnel)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(10)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("number")
          .setLabel("Numéro : de 0 à 36 (optionnel)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(2)
          .setRequired(false),
      ),
    );
}

// Ouvre le formulaire de pari quand un membre clique sur "Participer".
async function handleColorNumberJoinButton(interaction: ButtonInteraction) {
  const messageId = interaction.customId.slice(CNDRAW_JOIN_PREFIX.length);
  const state = ACTIVE_COLOR_NUMBER_DRAWS.get(messageId);

  if (!state || state.locked) {
    await interaction.reply({
      content: "Les paris sont clos ou cette partie n’existe plus.",
      ephemeral: true,
    });
    return;
  }

  await interaction.showModal(buildColorNumberBetModal(messageId));
}

// Valide et enregistre le pari soumis via le formulaire.
async function handleColorNumberBetModalSubmit(
  interaction: ModalSubmitInteraction,
) {
  const messageId = interaction.customId.slice(CNDRAW_MODAL_PREFIX.length);
  const state = ACTIVE_COLOR_NUMBER_DRAWS.get(messageId);

  if (!state || state.locked) {
    await interaction.reply({
      content: "Les paris sont clos, ton pari n’a pas été pris en compte.",
      ephemeral: true,
    });
    return;
  }

  const colorInput = interaction.fields
    .getTextInputValue("color")
    .trim()
    .toLowerCase();
  const numberInput = interaction.fields.getTextInputValue("number").trim();

  let color: ColorNumberBet["color"] = null;
  if (colorInput) {
    if (!["rouge", "noir", "vert"].includes(colorInput)) {
      await interaction.reply({
        content: "Couleur invalide. Utilise `rouge`, `noir` ou `vert`.",
        ephemeral: true,
      });
      return;
    }
    color = colorInput as "rouge" | "noir" | "vert";
  }

  let number: number | null = null;
  if (numberInput) {
    const parsed = Number.parseInt(numberInput, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 36) {
      await interaction.reply({
        content: "Numéro invalide. Choisis un nombre entier entre 0 et 36.",
        ephemeral: true,
      });
      return;
    }
    number = parsed;
  }

  if (color === null && number === null) {
    await interaction.reply({
      content: "Renseigne au moins une couleur ou un numéro.",
      ephemeral: true,
    });
    return;
  }

  state.bets.set(interaction.user.id, { color, number });

  const parts = [
    color ? `couleur **${color}**` : null,
    number !== null ? `numéro **${number}**` : null,
  ].filter(Boolean);

  await interaction.reply({
    content: `✅ Pari enregistré : ${parts.join(" et ")}.`,
    ephemeral: true,
  });
}

// Poste le message de mise, ouvre les paris pendant 30 secondes, puis les
// clôture (bouton désactivé) avant de rendre la main à l'appelant.
async function collectColorNumberBets(
  channel: TextChannel,
  embed: EmbedBuilder,
): Promise<{ message: Message; bets: Map<string, ColorNumberBet> }> {
  const message = await channel.send({
    embeds: [embed],
    components: [buildColorNumberJoinRow("pending")],
  });

  const state: ColorNumberDrawState = { bets: new Map(), locked: false };
  ACTIVE_COLOR_NUMBER_DRAWS.set(message.id, state);

  await message
    .edit({ components: [buildColorNumberJoinRow(message.id)] })
    .catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, CNDRAW_JOIN_DURATION_MS));

  state.locked = true;
  await message
    .edit({ components: [buildColorNumberJoinRow(message.id, true)] })
    .catch(() => undefined);

  return { message, bets: state.bets };
}

const ROULETTE_NUMBER_XP_REWARD = 500;
const ROULETTE_COLOR_XP_REWARD = 100;

async function handleRouletteCommand(interaction: ChatInputCommandInteraction) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  const channel = interaction.channel as TextChannel;
  const host = interaction.user;

  await interaction.reply({ content: "🎰 Roulette lancée !", ephemeral: true });

  const joinEmbed = new EmbedBuilder()
    .setTitle("🎰 Roulette — Placez vos paris !")
    .setDescription(
      "Clique sur **🎯 Participer** pour miser une couleur (rouge/noir/vert) et/ou un numéro (0-36).\nTu as **30 secondes** pour rejoindre !",
    )
    .setColor(0x9b59b6)
    .setFooter({
      text: `Numéro exact : +${ROULETTE_NUMBER_XP_REWARD} XP. Couleur seule : +${ROULETTE_COLOR_XP_REWARD} XP.`,
    });

  const { message, bets } = await collectColorNumberBets(channel, joinEmbed);

  // Petite animation de suspense avant le résultat final.
  for (let i = 0; i < 4; i++) {
    const preview = Math.floor(Math.random() * 37);
    await message
      .edit({
        embeds: [
          EmbedBuilder.from(joinEmbed).setDescription(
            `🎰 La roulette tourne... ${ROULETTE_COLOR_EMOJI[rouletteColor(preview)]} **${preview}**`,
          ),
        ],
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  const result = Math.floor(Math.random() * 37);
  const color = rouletteColor(result);

  const numberWinners: string[] = [];
  const colorWinners: string[] = [];

  for (const [userId, bet] of bets) {
    if (bet.number === result) {
      numberWinners.push(userId);
    } else if (bet.color === color) {
      colorWinners.push(userId);
    }
  }

  for (const userId of numberWinners) {
    await grantBonusXp(guild, userId, ROULETTE_NUMBER_XP_REWARD).catch(
      (err) => {
        logger.error({ err, userId }, "Failed to grant roulette number XP reward");
      },
    );
  }
  for (const userId of colorWinners) {
    await grantBonusXp(guild, userId, ROULETTE_COLOR_XP_REWARD).catch(
      (err) => {
        logger.error({ err, userId }, "Failed to grant roulette color XP reward");
      },
    );
  }

  const resultEmbed = new EmbedBuilder()
    .setTitle("🎰 Résultat de la roulette")
    .setColor(
      color === "rouge" ? 0xe74c3c : color === "noir" ? 0x2c3e50 : 0x2ecc71,
    )
    .addFields(
      {
        name: "Numéro",
        value: `${ROULETTE_COLOR_EMOJI[color]} **${result}** (${color})`,
        inline: true,
      },
      { name: "Participants", value: String(bets.size), inline: true },
      {
        name: `🏆 Numéro exact (+${ROULETTE_NUMBER_XP_REWARD} XP)`,
        value:
          numberWinners.length > 0
            ? numberWinners.map((id) => `<@${id}>`).join(", ")
            : "Personne",
      },
      {
        name: `🎨 Couleur seule (+${ROULETTE_COLOR_XP_REWARD} XP)`,
        value:
          colorWinners.length > 0
            ? colorWinners.map((id) => `<@${id}>`).join(", ")
            : "Personne",
      },
    )
    .setTimestamp();

  await message
    .edit({
      embeds: [resultEmbed],
      components: [buildColorNumberJoinRow(message.id, true)],
    })
    .catch(() => undefined);

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🎰 Roulette — Résultat")
      .setColor(0x9b59b6)
      .addFields(
        { name: "Résultat", value: `${result} (${color})`, inline: true },
        { name: "Participants", value: String(bets.size), inline: true },
        {
          name: "Gagnants numéro",
          value:
            numberWinners.length > 0
              ? numberWinners.map((id) => `<@${id}>`).join(", ")
              : "Aucun",
        },
        {
          name: "Gagnants couleur",
          value:
            colorWinners.length > 0
              ? colorWinners.map((id) => `<@${id}>`).join(", ")
              : "Aucun",
        },
        {
          name: "Animateur",
          value: `${host.tag}\n\`${host.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );

  ACTIVE_COLOR_NUMBER_DRAWS.delete(message.id);
}

const TIRAGE_EMOJI = "🎟️";

async function handleTirageCommand(interaction: ChatInputCommandInteraction) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  const prize = interaction.options.getString("prize", true);
  const durationSeconds = interaction.options.getInteger("duration") ?? 30;
  const channel = interaction.channel as TextChannel;
  const host = interaction.user;

  await interaction.reply({
    content: `🎟️ **Tirage au sort !**\n**Lot : ${prize}**\n\nRéagis avec ${TIRAGE_EMOJI} pour participer ! Tirage dans ${durationSeconds} secondes.`,
  });

  const message = await interaction.fetchReply();
  await message.react(TIRAGE_EMOJI).catch((err) => {
    logger.error(
      { err, messageId: message.id },
      "Failed to react to tirage message",
    );
  });

  setTimeout(async () => {
    const freshMessage = await channel.messages.fetch(message.id).catch(() => null);
    const reaction = freshMessage?.reactions.cache.get(TIRAGE_EMOJI);
    const reactedUsers = reaction
      ? await reaction.users.fetch().catch(() => null)
      : null;
    const participants: User[] = reactedUsers
      ? Array.from(reactedUsers.values()).filter((user) => !user.bot)
      : [];

    const winner: User | null =
      participants.length > 0
        ? participants[Math.floor(Math.random() * participants.length)]!
        : null;

    const resultEmbed = new EmbedBuilder()
      .setTitle("🎟️ Résultat du tirage")
      .setColor(winner ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: "Lot", value: prize },
        {
          name: "Participants",
          value: String(participants.length),
          inline: true,
        },
        {
          name: "🏆 Gagnant",
          value: winner ? `${winner}` : "Personne n'a participé.",
        },
      )
      .setTimestamp();

    await channel.send({ embeds: [resultEmbed] }).catch((err) => {
      logger.error({ err }, "Failed to announce tirage result");
    });

    await logToGuild(
      guild,
      new EmbedBuilder()
        .setTitle("🎟️ Tirage — Résultat")
        .setColor(0x3498db)
        .addFields(
          { name: "Lot", value: prize },
          {
            name: "Participants",
            value: String(participants.length),
            inline: true,
          },
          {
            name: "Gagnant",
            value: winner ? `${winner.tag}\n\`${winner.id}\`` : "Aucun",
          },
          {
            name: "Animateur",
            value: `${host.tag}\n\`${host.id}\``,
            inline: true,
          },
        )
        .setTimestamp(),
      "games",
    );
  }, durationSeconds * 1000);
}

// Compare deux réponses en ignorant la casse, les accents et les espaces
// superflus. Utilisé par /riddle et /scramble.
function normalizeGuess(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function handleRiddleCommand(interaction: ChatInputCommandInteraction) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content:
        "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const question = interaction.options.getString("question", true);
  const answer = interaction.options.getString("answer", true);
  const durationSeconds = interaction.options.getInteger("duration") ?? 60;
  const channel = interaction.channel as TextChannel;
  const normalizedAnswer = normalizeGuess(answer);

  await interaction.reply(
    `🧩 **Devinette !** ${question}\n\nRépondez directement dans ce salon, vous avez ${durationSeconds} secondes !`,
  );

  const winnerMessage = await runFirstAnswerGame(channel, {
    isCorrect: (content) => normalizeGuess(content) === normalizedAnswer,
    durationMs: durationSeconds * 1000,
  });

  if (winnerMessage) {
    await channel.send(
      `🎉 Bravo ${winnerMessage.author} ! La réponse était bien **${answer}**.`,
    );
  } else {
    await channel.send(
      `⏱️ Personne n'a trouvé à temps. La réponse était **${answer}**.`,
    );
  }

  await logToGuild(
    interaction.guild,
    new EmbedBuilder()
      .setTitle("🧩 Devinette — Résultat")
      .setColor(winnerMessage ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: "Question", value: question },
        { name: "Réponse", value: answer, inline: true },
        {
          name: "Gagnant",
          value: winnerMessage
            ? `${winnerMessage.author.tag}\n\`${winnerMessage.author.id}\``
            : "Personne",
          inline: true,
        },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

// Petite banque de mots pour /scramble. Ajoute/retire des mots ici si tu veux
// personnaliser la liste.
const SCRAMBLE_WORDS = [
  "ordinateur",
  "discord",
  "animation",
  "serveur",
  "aventure",
  "chocolat",
  "papillon",
  "montagne",
  "guitare",
  "elephant",
  "fantome",
  "planete",
  "silence",
  "voyage",
  "lumiere",
  "printemps",
  "chateau",
  "dragon",
  "musique",
  "jardin",
  "etoile",
  "secret",
  "vitesse",

];

function scrambleWord(word: string): string {
  const letters = word.split("");

  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j]!, letters[i]!];
  }

  const scrambled = letters.join("");
  // Évite (rarement) de retomber par hasard sur le mot original.
  return scrambled === word ? scrambleWord(word) : scrambled;
}

async function handleScrambleCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content:
        "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const durationSeconds = interaction.options.getInteger("duration") ?? 60;
  const word =
    SCRAMBLE_WORDS[Math.floor(Math.random() * SCRAMBLE_WORDS.length)]!;
  const scrambled = scrambleWord(word);
  const channel = interaction.channel as TextChannel;
  const normalizedWord = normalizeGuess(word);

  await interaction.reply(
    `🔤 **Mot mélangé !** Remets les lettres dans l'ordre : **${scrambled.toUpperCase()}**\n\nRépondez directement dans ce salon, vous avez ${durationSeconds} secondes !`,
  );

  const winnerMessage = await runFirstAnswerGame(channel, {
    isCorrect: (content) => normalizeGuess(content) === normalizedWord,
    durationMs: durationSeconds * 1000,
  });

  if (winnerMessage) {
    await channel.send(
      `🎉 Bravo ${winnerMessage.author} ! Le mot était bien **${word}**.`,
    );
  } else {
    await channel.send(
      `⏱️ Personne n'a trouvé à temps. Le mot était **${word}**.`,
    );
  }

  await logToGuild(
    interaction.guild,
    new EmbedBuilder()
      .setTitle("🔤 Mot mélangé — Résultat")
      .setColor(winnerMessage ? 0x2ecc71 : 0x95a5a6)
      .addFields(
        { name: "Mot", value: word, inline: true },
        { name: "Mélangé", value: scrambled, inline: true },
        {
          name: "Gagnant",
          value: winnerMessage
            ? `${winnerMessage.author.tag}\n\`${winnerMessage.author.id}\``
            : "Personne",
        },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

async function handleCountdownCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content:
        "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const label = interaction.options.getString("label", true);
  const pingRole = interaction.options.getRole("ping_role");

  await interaction.reply({
    content: pingRole ? `<@&${pingRole.id}>` : undefined,
    embeds: [
      new EmbedBuilder()
        .setTitle(`⏳ ${label}`)
        .setDescription("Préparez-vous...")
        .setColor(0xf1c40f),
    ],
    allowedMentions: pingRole ? { roles: [pingRole.id] } : { parse: [] },
  });

  const message = await interaction.fetchReply();

  for (const step of ["3️⃣", "2️⃣", "1️⃣"]) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await message
      .edit({
        embeds: [
          new EmbedBuilder()
            .setTitle(`⏳ ${label}`)
            .setDescription(`# ${step}`)
            .setColor(0xf1c40f),
        ],
      })
      .catch(() => undefined);
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  await message
    .edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(`⏳ ${label}`)
          .setDescription("# 🚀 GO !")
          .setColor(0x2ecc71),
      ],
    })
    .catch(() => undefined);

  await logToGuild(
    interaction.guild,
    new EmbedBuilder()
      .setTitle("⏳ Compte à rebours lancé")
      .setColor(0xf1c40f)
      .addFields(
        { name: "Activité", value: label },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

// Petites banques de prompts pour /truthordare. Complète-les si tu veux.
const TRUTH_PROMPTS = [
  "Quelle est la chose la plus embarrassante qui te soit arrivée ?",
  "Si tu pouvais changer une chose chez toi, ce serait quoi ?",
  "Quel est ton pire mensonge ?",
  "Qui, sur ce serveur, tu trouves le plus drôle ?",
  "Quelle est la dernière chose que tu as recherchée sur internet ?",
  "Quel est ton plus grand regret ?",
  "As-tu déjà eu un crush sur quelqu'un ici ?",
  "Quelle est la pire excuse que tu aies donnée pour ne pas faire quelque chose ?",
  ""
];

const DARE_PROMPTS = [
  "Envoie un emoji au hasard toutes les 10 secondes pendant 1 minute.",
  "Écris ton prochain message uniquement en émojis.",
  "Complimente les 3 derniers membres à avoir parlé dans ce salon.",
  "Raconte une blague, même mauvaise.",
  "Décris ta journée en seulement 3 mots.",
  "Envoie ton emoji préféré 5 fois de suite.",
  "Imite (par écrit) la façon de parler d'un pirate pendant 3 messages.",
  "Propose un défi à quelqu'un d'autre dans ce salon.",
];

async function handleTruthOrDareCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const choice =
    interaction.options.getString("type") ??
    (Math.random() < 0.5 ? "truth" : "dare");
  const target = interaction.options.getUser("user");
  const prompts = choice === "truth" ? TRUTH_PROMPTS : DARE_PROMPTS;
  const prompt = prompts[Math.floor(Math.random() * prompts.length)]!;
  const label = choice === "truth" ? "🤔 Vérité" : "🔥 Action";

  await interaction.reply({
    content: target ? `${target}` : undefined,
    embeds: [
      new EmbedBuilder()
        .setTitle(label)
        .setDescription(prompt)
        .setColor(choice === "truth" ? 0x3498db : 0xe74c3c),
    ],
    allowedMentions: target ? { users: [target.id] } : { parse: [] },
  });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle(`${label} — Tirage`)
      .setColor(choice === "truth" ? 0x3498db : 0xe74c3c)
      .addFields(
        { name: "Prompt", value: prompt },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}

const WYR_EMOJIS = ["🅰️", "🅱️"] as const;

async function handleWouldYouRatherCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;

  if (
    !guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const optionA = interaction.options.getString("option_a", true);
  const optionB = interaction.options.getString("option_b", true);
  const durationMinutes = interaction.options.getInteger("duration") ?? 2;
  const channel = interaction.channel as TextChannel;
  const host = interaction.user;

  const embed = new EmbedBuilder()
    .setTitle("🤔 Tu préfères...")
    .setColor(0x9b59b6)
    .setDescription(`🅰️ ${optionA}\n\n🅱️ ${optionB}`)
    .setFooter({ text: `Sondage lancé par ${host.tag} — résultats dans ${durationMinutes} min` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  const message = await interaction.fetchReply();

  for (const emoji of WYR_EMOJIS) {
    await message.react(emoji).catch((err) => {
      logger.error({ err, messageId: message.id }, "Failed to react to wouldyourather message");
    });
  }

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🤔 Tu préfères — Lancé")
      .setColor(0x9b59b6)
      .addFields(
        { name: "Option A", value: optionA, inline: true },
        { name: "Option B", value: optionB, inline: true },
        { name: "Salon", value: `<#${channel.id}>`, inline: true },
        {
          name: "Animateur",
          value: `${host.tag}\n\`${host.id}\``,
          inline: true,
        },
        { name: "Durée", value: `${durationMinutes} minute(s)`, inline: true },
      )
      .setTimestamp(),
    "games",
  );

  setTimeout(
    async () => {
      const freshMessage = await channel.messages.fetch(message.id).catch(() => null);

      if (!freshMessage) {
        return;
      }

      const countA = Math.max(
        0,
        (freshMessage.reactions.cache.get(WYR_EMOJIS[0])?.count ?? 1) - 1,
      );
      const countB = Math.max(
        0,
        (freshMessage.reactions.cache.get(WYR_EMOJIS[1])?.count ?? 1) - 1,
      );

      const resultText =
        countA === countB
          ? `Égalité parfaite ! (${countA} vote(s) chacun)`
          : countA > countB
            ? `🅰️ **${optionA}** l'emporte avec ${countA} vote(s) contre ${countB} !`
            : `🅱️ **${optionB}** l'emporte avec ${countB} vote(s) contre ${countA} !`;

      await channel.send(`📊 Résultats de "Tu préfères..." : ${resultText}`).catch((err) => {
        logger.error({ err, messageId: message.id }, "Failed to announce wouldyourather results");
      });

      await logToGuild(
        guild,
        new EmbedBuilder()
          .setTitle("🤔 Tu préfères — Résultat")
          .setColor(0x2ecc71)
          .addFields(
            { name: "Option A", value: `${optionA} — ${countA} vote(s)`, inline: true },
            { name: "Option B", value: `${optionB} — ${countB} vote(s)`, inline: true },
            { name: "Message", value: `\`${message.id}\``, inline: true },
          )
          .setTimestamp(),
        "games",
      );
    },
    durationMinutes * 60 * 1000,
  );
}

async function handleHotSeatCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannel = member?.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: "Tu dois être dans un salon vocal pour utiliser cette commande.",
      ephemeral: true,
    });
    return;
  }

  const candidates: GuildMember[] = Array.from(
    voiceChannel.members.values(),
  ).filter((candidate) => !candidate.user.bot);

  if (candidates.length === 0) {
    await interaction.reply({
      content: "Il n'y a personne dans ton salon vocal pour jouer.",
      ephemeral: true,
    });
    return;
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)]!;

  await interaction.reply({
    content: `🎤 **Sous le feu des projecteurs :** ${chosen} !`,
  });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🎤 Hot Seat")
      .setColor(0xe67e22)
      .addFields(
        { name: "Salon vocal", value: voiceChannel.name, inline: true },
        {
          name: "Membre désigné",
          value: `${chosen.user.tag}\n\`${chosen.id}\``,
          inline: true,
        },
        {
          name: "Animateur",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "games",
  );
}


// Affiche le menu déroulant "Créer" / "Retirer".
async function showCustomRoleMenu(interaction: ChatInputCommandInteraction) {
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CUSTOMROLE_MENU_SELECT_ID)
      .setPlaceholder("Que veux-tu faire ?")
      .addOptions(
        {
          label: "Créer un rôle personnalisé",
          description: "Ouvre un formulaire à remplir.",
          value: "create",
          emoji: "🎭",
        },
        {
          label: "Retirer un rôle personnalisé",
          description: "Choisis un rôle actif à supprimer.",
          value: "remove",
          emoji: "🗑️",
        },
      ),
  );

  await interaction.reply({
    content: "Choisis une action :",
    components: [row],
    ephemeral: true,
  });
}

// Étape 1 du menu : l'utilisateur choisit "Créer" ou "Retirer".
async function handleCustomRoleMenuSelect(
  interaction: StringSelectMenuInteraction,
) {
  if (!(await hasCustomRoleAccess(interaction))) {
    await interaction.update({
      content:
        "Tu n'as pas la permission d'utiliser cette fonctionnalité.",
      components: [],
    });
    return;
  }

  const choice = interaction.values[0];

  if (choice === "create") {
    await interaction.showModal(buildCustomRoleCreateModal());
    return;
  }

  if (choice === "remove") {
    await showCustomRoleRemoveSelect(interaction);
  }
}

// Construit le formulaire de création (5 champs = maximum autorisé par Discord).
function buildCustomRoleCreateModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CUSTOMROLE_CREATE_MODAL_ID)
    .setTitle("Créer un rôle personnalisé")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Nom du rôle")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("owner")
          .setLabel("Propriétaire (ID ou @mention)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Durée (ex : 1j2h30m, 10m, 2h)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("Couleur hexadécimale (optionnel)")
          .setPlaceholder("#ff0000")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Raison (optionnel)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
}

// Traite la soumission du formulaire de création.
async function handleCustomRoleCreateModalSubmit(
  interaction: ModalSubmitInteraction,
) {
  if (!(await hasCustomRoleAccess(interaction))) {
    await interaction.reply({
      content: "Tu n'as pas la permission d'utiliser cette fonctionnalité.",
      ephemeral: true,
    });
    return;
  }

  const name = interaction.fields.getTextInputValue("name");
  const ownerInput = interaction.fields.getTextInputValue("owner");
  const durationInput = interaction.fields.getTextInputValue("duration");
  const colorInput = interaction.fields.getTextInputValue("color") || null;
  const reason =
    interaction.fields.getTextInputValue("reason") || "Aucune raison fournie.";

  await createCustomRoleFromInput(interaction, {
    name,
    ownerInput,
    durationInput,
    colorInput,
    reason,
  });
}

// Étape 2 du menu (choix "Retirer") : liste les rôles actifs du serveur dans
// un nouveau select menu, jusqu'à 25 (limite Discord par menu).
async function showCustomRoleRemoveSelect(
  interaction: StringSelectMenuInteraction,
) {
  if (!interaction.guild) {
    await interaction.update({
      content: "Cette action doit être utilisée dans un serveur.",
      components: [],
    });
    return;
  }

  const roles = Array.from(ACTIVE_CUSTOM_ROLES.values()).filter(
    (state) => state.guildId === interaction.guild!.id,
  );

  if (roles.length === 0) {
    await interaction.update({
      content: "Aucun rôle personnalisé actif à retirer.",
      components: [],
    });
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CUSTOMROLE_REMOVE_SELECT_ID)
      .setPlaceholder("Choisis le rôle à retirer…")
      .addOptions(
        roles.slice(0, 25).map((state) => ({
          label: state.name.slice(0, 100),
          description: `Propriétaire : ${state.ownerId}`.slice(0, 100),
          value: state.roleId,
        })),
      ),
  );

  await interaction.update({
    content:
      roles.length > 25
        ? "Sélectionne le rôle personnalisé à supprimer (25 premiers affichés) :"
        : "Sélectionne le rôle personnalisé à supprimer :",
    components: [row],
  });
}

// Traite le choix final du rôle à retirer.
async function handleCustomRoleRemoveSelect(
  interaction: StringSelectMenuInteraction,
) {
  if (!(await hasCustomRoleAccess(interaction))) {
    await interaction.update({
      content: "Tu n'as pas la permission d'utiliser cette fonctionnalité.",
      components: [],
    });
    return;
  }

  const roleId = interaction.values[0];
  const state = ACTIVE_CUSTOM_ROLES.get(roleId);

  if (!state || state.guildId !== interaction.guild?.id) {
    await interaction.update({
      content: "Ce rôle n'est plus disponible (déjà supprimé ou expiré).",
      components: [],
    });
    return;
  }

  await expireCustomRole(interaction.client, roleId, true, {
    tag: interaction.user.tag,
    id: interaction.user.id,
  });

  await interaction.update({
    content: `Le rôle **${state.name}** a été supprimé.`,
    components: [],
  });
}

async function createCustomRoleFromInput(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  input: {
    name: string;
    ownerInput: string;
    durationInput: string;
    colorInput: string | null;
    reason: string;
  },
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const { name, durationInput, colorInput, reason } = input;

  // Accepte un ID brut ou une mention (<@123>, <@!123>).
  const ownerId = input.ownerInput.replace(/[<@!>]/g, "").trim();

  if (!/^\d+$/.test(ownerId)) {
    await interaction.reply({
      content:
        "Propriétaire invalide. Indique un identifiant Discord ou une mention (@membre).",
      ephemeral: true,
    });
    return;
  }

  const durationMs = parseDuration(durationInput);

  if (!durationMs) {
    await interaction.reply({
      content:
        "Format de durée invalide. Exemples valides : `10m`, `2h`, `1j2h30m`.",
      ephemeral: true,
    });
    return;
  }

  if (durationMs < CUSTOM_ROLE_MIN_DURATION_MS) {
    await interaction.reply({
      content: "La durée minimale d’un rôle personnalisé est de 1 minute.",
      ephemeral: true,
    });
    return;
  }

  if (durationMs > CUSTOM_ROLE_MAX_DURATION_MS) {
    await interaction.reply({
      content: "La durée maximale d’un rôle personnalisé est de 365 jours.",
      ephemeral: true,
    });
    return;
  }

  let color: number | undefined;
  if (colorInput) {
    const parsedColor = parseHexColor(colorInput);
    if (parsedColor === null) {
      await interaction.reply({
        content:
          "Couleur invalide. Utilise un format hexadécimal, ex : `#ff0000`.",
        ephemeral: true,
      });
      return;
    }
    color = parsedColor;
  }

  const ownerMember = await guild.members.fetch(ownerId).catch(() => null);

  if (!ownerMember) {
    await interaction.reply({
      content: "Ce membre ne fait pas partie de ce serveur.",
      ephemeral: true,
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "Je n’ai pas la permission Discord « Gérer les rôles ».",
      ephemeral: true,
    });
    return;
  }

  let newRole;
  try {
    newRole = await guild.roles.create({
      name,
      color,
      reason: `Rôle personnalisé pour ${ownerMember.user.tag} : ${reason}`,
    });
  } catch (err) {
    logger.error({ err, name }, "Failed to create custom role");
    await interaction.reply({
      content:
        "Impossible de créer le rôle (vérifie que j’ai bien la permission « Gérer les rôles »).",
      ephemeral: true,
    });
    return;
  }

  const membresRoleId = process.env.DISCORD_MEMBRES_ROLE_ID;
  const membresRole = membresRoleId
    ? await guild.roles.fetch(membresRoleId).catch(() => null)
    : null;

  if (membresRole) {
    await newRole.setPosition(membresRole.position + 1).catch((err) => {
      logger.error(
        { err, roleId: newRole.id },
        "Failed to position custom role above membres role",
      );
    });
  }

  try {
    await ownerMember.roles.add(newRole, reason);
  } catch (err) {
    logger.error(
      { err, roleId: newRole.id, ownerId: ownerMember.id },
      "Failed to assign custom role to owner",
    );
    await newRole
      .delete("Échec de l’attribution au propriétaire")
      .catch(() => undefined);
    await interaction.reply({
      content:
        "Impossible d’attribuer le rôle au membre (le rôle a été annulé). Vérifie ma position dans la hiérarchie des rôles.",
      ephemeral: true,
    });
    return;
  }

  const now = Date.now();
  const expiresAt = now + durationMs;

  try {
    await db.insert(discordCustomRolesTable).values({
      roleId: newRole.id,
      guildId: guild.id,
      ownerId: ownerMember.id,
      name,
      reason,
      createdAt: new Date(now),
      expiresAt: new Date(expiresAt),
    });
  } catch (err) {
    logger.error(
      { err, roleId: newRole.id, guildId: guild.id },
      "Failed to persist custom role",
    );
    await newRole
      .delete("Échec de l’enregistrement du rôle personnalisé")
      .catch(() => undefined);
    await interaction.reply({
      content:
        "Impossible d’enregistrer le rôle personnalisé. Le rôle Discord a été annulé.",
      ephemeral: true,
    });
    return;
  }

  const state: CustomRoleState = {
    roleId: newRole.id,
    guildId: guild.id,
    ownerId: ownerMember.id,
    name,
    reason,
    createdAt: now,
    expiresAt,
    timeout: null,
  };

  const client = interaction.client;
  ACTIVE_CUSTOM_ROLES.set(newRole.id, state);
  scheduleCustomRoleExpiration(client, state);

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🎭 Rôle personnalisé créé")
      .setColor(color ?? 0x9b59b6)
      .addFields(
        { name: "Rôle", value: `${newRole}\n\`${newRole.id}\``, inline: true },
        {
          name: "Propriétaire",
          value: `${ownerMember.user.tag}\n\`${ownerMember.id}\``,
          inline: true,
        },
        {
          name: "Expire",
          value: `<t:${Math.floor(expiresAt / 1000)}:R>`,
          inline: true,
        },
        { name: "Raison", value: reason },
        {
          name: "Créé par",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "customRoles",
  );

  // Confirmation publique dans le salon où la commande a été exécutée
  // (en plus du log dans le salon customRoles), en pingant le rôle créé.
  if (interaction.channel && "send" in interaction.channel) {
    await interaction.channel
      .send({
        content: [
          `🎭 Rôle personnalisé créé : ${newRole}`,
          `Modérateur : ${interaction.user.tag} (\`${interaction.user.id}\`)`,
          `Heure : <t:${Math.floor(now / 1000)}:F>`,
        ].join("\n"),
        allowedMentions: { roles: [newRole.id] },
      })
      .catch((err) => {
        logger.error(
          { err, roleId: newRole.id },
          "Failed to send customrole confirmation in channel",
        );
      });
  }

  await interaction.reply({
    content: `Le rôle ${newRole} a été créé et attribué à ${ownerMember}. Il sera automatiquement supprimé <t:${Math.floor(expiresAt / 1000)}:R>.`,
    ephemeral: true,
  });
}

async function restoreCustomRoles(client: DiscordClient<boolean>) {
  let persistedRoles: Array<{
    roleId: string;
    guildId: string;
    ownerId: string;
    name: string;
    reason: string;
    createdAt: Date;
    expiresAt: Date;
  }>;

  try {
    persistedRoles = await db
      .select()
      .from(discordCustomRolesTable);
  } catch (err) {
    logger.error({ err }, "Failed to load persisted custom roles");
    return;
  }

  let restoredCount = 0;
  let cleanedCount = 0;

  for (const persisted of persistedRoles) {
    const guild =
      client.guilds.cache.get(persisted.guildId) ??
      (await client.guilds.fetch(persisted.guildId).catch(() => null));

    if (!guild) {
      await db
        .delete(discordCustomRolesTable)
        .where(eq(discordCustomRolesTable.roleId, persisted.roleId))
        .catch((err) => {
          logger.error(
            { err, guildId: persisted.guildId, roleId: persisted.roleId },
            "Failed to clean custom role from an unavailable guild",
          );
        });
      cleanedCount += 1;
      logger.warn(
        { guildId: persisted.guildId, roleId: persisted.roleId },
        "Removed persisted custom role from a guild the bot is no longer in",
      );
      continue;
    }

    const role = await guild.roles.fetch(persisted.roleId).catch(() => null);
    if (!role) {
      await db
        .delete(discordCustomRolesTable)
        .where(eq(discordCustomRolesTable.roleId, persisted.roleId))
        .catch((err) => {
          logger.error(
            { err, roleId: persisted.roleId },
            "Failed to clean missing persisted custom role",
          );
        });
      cleanedCount += 1;
      logger.warn(
        { guildId: persisted.guildId, roleId: persisted.roleId },
        "Removed persisted custom role whose Discord role no longer exists",
      );
      continue;
    }

    const state: CustomRoleState = {
      roleId: persisted.roleId,
      guildId: persisted.guildId,
      ownerId: persisted.ownerId,
      name: persisted.name,
      reason: persisted.reason,
      createdAt: persisted.createdAt.getTime(),
      // La date d’expiration persistée est la source de vérité. Ne pas la
      // recalculer ou la plafonner au redémarrage, sinon un rôle long serait
      // supprimé prématurément après restauration.
      expiresAt: persisted.expiresAt.getTime(),
      timeout: null,
    };

    ACTIVE_CUSTOM_ROLES.set(state.roleId, state);

    if (state.expiresAt <= Date.now()) {
      await expireCustomRole(client, state.roleId);
      cleanedCount += 1;
      continue;
    }

    const ownerMember = await guild.members
      .fetch(state.ownerId)
      .catch(() => null);
    if (ownerMember && !ownerMember.roles.cache.has(state.roleId)) {
      await ownerMember.roles.add(role, "Restauration d’un rôle personnalisé").catch((err) => {
        logger.warn(
          { err, guildId: state.guildId, roleId: state.roleId, ownerId: state.ownerId },
          "Failed to restore custom role assignment",
        );
      });
    }

    scheduleCustomRoleExpiration(client, state);
    restoredCount += 1;
  }

  logger.info(
    { persisted: persistedRoles.length, restored: restoredCount, cleaned: cleanedCount },
    "Custom roles restored",
  );
}

async function expireCustomRole(
  client: DiscordClient<boolean>,
  roleId: string,
  manual = false,
  moderator?: { tag: string; id: string },
) {
  const state = ACTIVE_CUSTOM_ROLES.get(roleId);

  if (!state) {
    return;
  }

  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }

  ACTIVE_CUSTOM_ROLES.delete(roleId);

  await db
    .delete(discordCustomRolesTable)
    .where(eq(discordCustomRolesTable.roleId, roleId))
    .catch((err) => {
      logger.error({ err, roleId }, "Failed to delete persisted custom role");
    });

  const guild = await client.guilds.fetch(state.guildId).catch(() => null);

  if (!guild) {
    return;
  }

  const role = await guild.roles.fetch(roleId).catch(() => null);

  await role
    ?.delete(
      manual
        ? "Rôle personnalisé supprimé manuellement"
        : "Durée du rôle personnalisé écoulée",
    )
    .catch((err) => {
      logger.error({ err, roleId }, "Failed to delete expired custom role");
    });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle(
        manual
          ? "🎭 Rôle personnalisé supprimé manuellement"
          : "🎭 Rôle personnalisé expiré",
      )
      .setColor(0xe74c3c)
      .addFields(
        { name: "Rôle", value: `${state.name}\n\`${roleId}\``, inline: true },
        {
          name: "Propriétaire",
          value: `<@${state.ownerId}>\n\`${state.ownerId}\``,
          inline: true,
        },
        ...(moderator
          ? [
              {
                name: "Supprimé par",
                value: `${moderator.tag}\n\`${moderator.id}\``,
                inline: true,
              },
            ]
          : []),
      )
      .setTimestamp(),
    "customRoles",
  );
}

async function listCustomRoles(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const roles = Array.from(ACTIVE_CUSTOM_ROLES.values()).filter(
    (state) => state.guildId === guild.id,
  );

  if (roles.length === 0) {
    await interaction.reply({
      content: "Aucun rôle personnalisé actif.",
      ephemeral: true,
    });
    return;
  }

  const description = roles
    .map(
      (state) =>
        `<@&${state.roleId}> — propriétaire <@${state.ownerId}> — expire <t:${Math.floor(state.expiresAt / 1000)}:R>`,
    )
    .join("\n");

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Rôles personnalisés actifs")
        .setColor(0x9b59b6)
        .setDescription(description)
        .setTimestamp(),
    ],
    ephemeral: true,
  });
}

const EIGHT_BALL_ANSWERS = [
  "Oui",
  "Non",
  "Très certainement",
  "Pourquoi tu me demandes ?",
  "Va voir ailleurs si j'y suis.",
  "Un ksos comme toi me demande ça ?",
  "Je ne suis pas un oracle, je suis un bot.",
  "Pourquoi poser cette question ? Tu connais déjà la réponse.",
  "J'aurai tout vu...",
  "Je t'avoue que je m'en fou de toi.",
  "Un membre avec aussi peu de IQ ici... C'est possible ?",
];

// Ajoute de l'XP à un membre (hors système de messages), applique les
// récompenses de palier si un niveau est franchi, et retourne le nouveau
// total pour affichage.
async function grantBonusXp(
  guild: Guild,
  userId: string,
  amount: number,
): Promise<{ newXp: number; newLevel: number }> {
  const currentXp = await getUserXp(guild.id, userId);
  const previousLevel = calculateLevel(currentXp).level;
  const newXp = currentXp + amount;

  await setUserXp(guild.id, userId, newXp);

  const newLevel = calculateLevel(newXp).level;

  if (newLevel !== previousLevel) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await grantLevelUpRewards(guild, member, previousLevel, newLevel);
    }
  }

  return { newXp, newLevel };
}

const DROPXP_EMOJI = "🎁";

async function handleDropXpCommand(interaction: ChatInputCommandInteraction) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un salon textuel d'un serveur.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  const channel = interaction.channel as TextChannel;
  const amount = interaction.options.getInteger("amount", true);
  const host = interaction.user;

  await interaction.reply({ content: "🎁 Drop d'XP lancé !", ephemeral: true });

  const message = await channel.send(
    `${DROPXP_EMOJI} **Drop de ${amount} XP !** Le premier ou la première à réagir avec ${DROPXP_EMOJI} le remporte !`,
  );

  await message.react(DROPXP_EMOJI).catch((err) => {
    logger.error({ err, messageId: message.id }, "Failed to react to dropxp message");
  });

  const collector = message.createReactionCollector({
    filter: (reaction, user) =>
      reaction.emoji.name === DROPXP_EMOJI && !user.bot,
    max: 1,
    time: 5 * 60 * 1000,
  });

  collector.on("collect", async (_reaction, user) => {
    const { newXp, newLevel } = await grantBonusXp(guild, user.id, amount).catch(
      (err) => {
        logger.error({ err, userId: user.id }, "Failed to grant dropxp reward");
        return { newXp: null, newLevel: null };
      },
    );

    await channel
      .send(`🎉 ${user} remporte le drop de **${amount} XP** !`)
      .catch((err) => {
        logger.error({ err }, "Failed to announce dropxp winner");
      });

    await logToGuild(
      guild,
      new EmbedBuilder()
        .setTitle("🎁 Drop XP — Résultat")
        .setColor(0x2ecc71)
        .addFields(
          { name: "Montant", value: String(amount), inline: true },
          {
            name: "Gagnant",
            value: `${user.tag}\n\`${user.id}\``,
            inline: true,
          },
          ...(newXp !== null
            ? [
                {
                  name: "Nouveau total",
                  value: `${newXp} XP (niveau ${newLevel})`,
                  inline: true,
                },
              ]
            : []),
          {
            name: "Animateur",
            value: `${host.tag}\n\`${host.id}\``,
            inline: true,
          },
        )
        .setTimestamp(),
      "games",
    );
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      await channel
        .send("⏱️ Personne n'a récupéré le drop d'XP à temps.")
        .catch((err) => {
          logger.error({ err }, "Failed to announce dropxp timeout");
        });

      await logToGuild(
        guild,
        new EmbedBuilder()
          .setTitle("🎁 Drop XP — Personne ne l'a récupéré")
          .setColor(0x95a5a6)
          .addFields(
            { name: "Montant", value: String(amount), inline: true },
            {
              name: "Animateur",
              value: `${host.tag}\n\`${host.id}\``,
              inline: true,
            },
          )
          .setTimestamp(),
        "games",
      );
    }
  });
}

async function handleEightBall(interaction: ChatInputCommandInteraction) {
  const question = interaction.options.getString("question", true);
  const answer =
    EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎱 Boule magique")
        .setColor(0x2c3e50)
        .addFields(
          ...buildEightBallResponseFields(
            interaction.user.tag,
            interaction.user.id,
            question,
            answer,
          ),
        ),
    ],
  });
}

async function handleDice(interaction: ChatInputCommandInteraction) {
  const sides = interaction.options.getInteger("sides") ?? 6;
  const count = interaction.options.getInteger("count") ?? 1;

  const rolls = Array.from(
    { length: count },
    () => 1 + Math.floor(Math.random() * sides),
  );
  const total = rolls.reduce((sum, value) => sum + value, 0);

  await interaction.reply(
    count > 1
      ? `🎲 Résultats (d${sides}) : ${rolls.join(", ")} — total : **${total}**`
      : `🎲 Résultat (d${sides}) : **${rolls[0]}**`,
  );
}

const JOKES = [
  "Pourquoi les plongeurs plongent-ils toujours en arrière et jamais en avant ? Parce que sinon ils tombent dans le bateau.",
  "Qu'est-ce qu'un crocodile qui surveille la pharmacie ? Un pharmacocroc.",
  "Que fait une fraise sur un cheval ? Tagada tagada tagada.",
  "Pourquoi les poissons détestent-ils jouer au tennis ? Parce qu'ils ont peur du filet.",
  "Quel est le comble pour un électricien ? Ne pas être au courant.",
  "Comment appelle-t-on un chat tout seul ? Un chat-solitaire.",
  "Pourquoi le football c'est bien ? Parce que sinon ce serait juste un rectangle vert avec des gens qui courent après une balle en criant.",
];

async function handleJoke(interaction: ChatInputCommandInteraction) {
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
  await interaction.reply(`😄 ${joke}`);
}

async function sendAsBot(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const content = interaction.options.getString("message", true);
  const selectedChannel = interaction.options.getChannel("channel");
  const channel = selectedChannel ?? interaction.channel;

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.reply({
      content: "Le salon choisi ne permet pas l’envoi de messages.",
      ephemeral: true,
    });
    return;
  }

  const textChannel = channel as TextChannel;
  await textChannel.send({
    content,
    allowedMentions: { parse: [] },
  });
  await interaction.reply({
    content: `Message envoyé dans <#${channel.id}> sous l’identité du bot.`,
    ephemeral: true,
  });
}

// --- Absences ---

type AbsenceState = {
  messageId: string;
  channelId: string;
  userId: string;
  duration: string;
  reason: string;
  authorId: string;
  authorTag: string;
};

const ACTIVE_ABSENCES = new Map<string, AbsenceState>();

function buildAbsenceEmbed(absence: AbsenceState) {
  return new EmbedBuilder()
    .setTitle("📋 Absence")
    .setColor(0x3498db)
    .addFields(
      { name: "Membre", value: `<@${absence.userId}>`, inline: true },
      { name: "Durée", value: absence.duration, inline: true },
      { name: "Raison", value: absence.reason, inline: false },
    )
    .setFooter({ text: `Déclarée par ${absence.authorTag}` })
    .setTimestamp();
}

async function handleAbsenceCommand(interaction: ChatInputCommandInteraction) {
  const isOwner = await isBotOwnerInteraction(interaction);
  const settings = interaction.guild
    ? await getGuildSettings(interaction.guild.id)
    : emptyGuildSettings();
  const absenceCommandChannelId = settings.channelIds.absenceCommand;

  if (!isOwner && absenceCommandChannelId && interaction.channelId !== absenceCommandChannelId) {
    await interaction.reply({
      content: `Cette commande n'est utilisable que dans <#${absenceCommandChannelId}>.`,
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    await addAbsence(interaction);
    return;
  }

  if (subcommand === "edit") {
    await editAbsence(interaction);
    return;
  }
}

async function addAbsence(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const user = interaction.options.getUser("member", true);
  const duration = interaction.options.getString("duration", true);
  const reason = interaction.options.getString("reason", true);
  const settings = await getGuildSettings(guild.id);
  const absenceLogChannelId = settings.channelIds.absenceLog;
  const absencePingRoleId = settings.roleIds.absencePing;

  const channel = await guild.channels
    .fetch(absenceLogChannelId ?? "")
    .catch(() => null);

  if (!channel || !("send" in channel)) {
    await interaction.reply({
      content: "Le salon des absences est introuvable ou mal configuré.",
      ephemeral: true,
    });
    return;
  }

  const draft: Omit<AbsenceState, "messageId"> = {
    channelId: channel.id,
    userId: user.id,
    duration,
    reason,
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
  };

  const message = await channel.send({
    content: absencePingRoleId ? `<@&${absencePingRoleId}>` : undefined,
    embeds: [buildAbsenceEmbed({ ...draft, messageId: "" })],
    allowedMentions: absencePingRoleId
      ? { roles: [absencePingRoleId] }
      : { parse: [] },
  });

  ACTIVE_ABSENCES.set(message.id, { ...draft, messageId: message.id });

  await interaction.reply({
    content: `Absence enregistrée pour **${user.tag}** dans <#${channel.id}>. (id : \`${message.id}\`)`,
    ephemeral: true,
  });
}

async function editAbsence(interaction: ChatInputCommandInteraction) {
  const isOwner = await isBotOwnerInteraction(interaction);

  if (
    !isOwner &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content:
        "`*abs edit` est réservée aux membres ayant la permission Administrateur.",
      ephemeral: true,
    });
    return;
  }

  const messageId = interaction.options.getString("message_id", true);
  const absence = ACTIVE_ABSENCES.get(messageId);

  if (!absence) {
    await interaction.reply({
      content: "Aucune absence trouvée avec cet identifiant.",
      ephemeral: true,
    });
    return;
  }

  const user = interaction.options.getUser("member");
  const duration = interaction.options.getString("duration");
  const reason = interaction.options.getString("reason");

  if (!user && !duration && !reason) {
    await interaction.reply({
      content:
        "Précise au moins un champ à modifier (membre, durée ou raison).",
      ephemeral: true,
    });
    return;
  }

  if (user) absence.userId = user.id;
  if (duration) absence.duration = duration;
  if (reason) absence.reason = reason;

  const channel = await interaction.guild?.channels
    .fetch(absence.channelId)
    .catch(() => null);

  if (!channel || !("messages" in channel)) {
    await interaction.reply({
      content: "Le salon des absences est introuvable.",
      ephemeral: true,
    });
    return;
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);

  if (!message) {
    await interaction.reply({
      content: "Le message de l'absence est introuvable (supprimé ?).",
      ephemeral: true,
    });
    return;
  }

  await message.edit({ embeds: [buildAbsenceEmbed(absence)] });

  await interaction.reply({
    content: "Absence mise à jour.",
    ephemeral: true,
  });
}

// Petit suffixe réutilisé dans les réponses de /warn, /mute, /ban, /kick
// pour que le modérateur ait l'ID de la sanction sous la main (utile pour
// /editsanction, /resetmuteban, etc.) sans devoir repasser par /sanctions.
function formatSanctionIdSuffix(sanctionId: number | null): string {
  return sanctionId !== null ? ` (ID : \`${sanctionId}\`)` : "";
}

async function saveSanction(
  sanction: NewDiscordSanction,
): Promise<number | null> {
  try {
    const [inserted] = await db
      .insert(discordSanctionsTable)
      .values(sanction)
      .returning({ id: discordSanctionsTable.id });
    return inserted?.id ?? null;
  } catch (err) {
    logger.error({ err, action: sanction.action }, "Failed to save sanction");
    return null;
  }
}
async function logSanction(
  guild: Guild,
  sanction: {
    sanctionId: number | null;
    action: string;
    targetId: string;
    targetTag: string;
    targetNickname?: string | null;
    moderatorId: string;
    moderatorTag: string;
    reason: string;
    durationMinutes?: number;
  },
) {
  const embed = new EmbedBuilder()
    .setTitle(`Sanction : ${sanction.action.toUpperCase()}`)
    .setColor(
      isReversalSanction(sanction.action)
        ? REVERSAL_SANCTION_COLOR
        : DEFAULT_SANCTION_COLOR,
    )
    .setDescription(
      [
        `ID : \`${sanction.targetId}\``,
        `User : ${sanction.targetTag}`,
        `Pseudo : ${sanction.targetNickname ?? "Aucun pseudo"}`,
      ].join("\n"),
    )
    .addFields(
      { name: "Type", value: sanction.action.toUpperCase(), inline: true },
      {
        name: "Modérateur",
        value: `${sanction.moderatorTag}\n\`${sanction.moderatorId}\``,
        inline: true,
      },
      { name: "Raison", value: sanction.reason },
      {
        name: "ID sanction",
        value:
          sanction.sanctionId !== null
            ? `\`${sanction.sanctionId}\` (utilise-le avec /editsanction)`
            : "Inconnu",
      },
    )
    .setTimestamp();

  if (sanction.durationMinutes) {
    embed.addFields({
      name: "Durée",
      value: `${sanction.durationMinutes} minute(s)`,
      inline: true,
    });
  }

  await logToGuild(guild, embed, "sanctions");
}

function isProtectedSecurityTarget(guild: Guild, member: GuildMember): boolean {
  return (
    member.id === guild.ownerId ||
    member.id === BOT_OWNER_ID ||
    member.id === guild.client.user?.id ||
    BOT_OWNER_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
  );
}

async function applyAutomatedTimeout(
  guild: Guild,
  member: GuildMember,
  reason: string,
  durationMinutes: number,
) {
  if (
    isProtectedSecurityTarget(guild, member) ||
    !member.moderatable ||
    !guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    return null;
  }

  const cooldownKey = `${guild.id}:${member.id}:mute`;
  const now = Date.now();
  if (
    now - (AUTOMATED_SANCTION_COOLDOWNS.get(cooldownKey) ?? 0) <
    AUTOMATED_SANCTION_COOLDOWN_MS
  ) {
    return null;
  }
  AUTOMATED_SANCTION_COOLDOWNS.set(cooldownKey, now);

  const moderator = guild.members.me;
  const moderatorId = moderator?.id ?? guild.client.user?.id ?? "system";
  const moderatorTag = moderator?.user.tag ?? guild.client.user?.tag ?? "Infinity Hub";
  const delivered = await member
    .send(
      `Tu as reçu un timeout automatique sur **${guild.name}** pendant **${durationMinutes} minute(s)**.\nDate : <t:${Math.floor(now / 1000)}:F>\nRaison : ${reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
    )
    .then(() => true)
    .catch(() => false);

  try {
    await member.timeout(durationMinutes * 60 * 1000, reason);
  } catch (err) {
    AUTOMATED_SANCTION_COOLDOWNS.delete(cooldownKey);
    logger.warn(
      { err, guildId: guild.id, userId: member.id },
      "Failed to apply automated timeout",
    );
    return null;
  }

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "mute",
    targetId: member.id,
    targetTag: member.user.tag,
    moderatorId,
    moderatorTag,
    reason,
    durationMinutes,
  });
  await logSanction(guild, {
    sanctionId,
    action: "mute",
    targetId: member.id,
    targetTag: member.user.tag,
    targetNickname: member.nickname,
    moderatorId,
    moderatorTag,
    reason,
    durationMinutes,
  }).catch((err) =>
    logger.error({ err, guildId: guild.id, userId: member.id }, "Failed to log automated timeout"),
  );

  return { sanctionId, delivered };
}

async function applyAutomatedBan(
  guild: Guild,
  member: GuildMember,
  reason: string,
) {
  if (
    isProtectedSecurityTarget(guild, member) ||
    !member.bannable ||
    !guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)
  ) {
    return null;
  }

  const cooldownKey = `${guild.id}:${member.id}:ban`;
  if (SECURITY_NUKE_HANDLED.has(cooldownKey)) {
    return null;
  }
  SECURITY_NUKE_HANDLED.add(cooldownKey);

  const moderator = guild.members.me;
  const moderatorId = moderator?.id ?? guild.client.user?.id ?? "system";
  const moderatorTag = moderator?.user.tag ?? guild.client.user?.tag ?? "Infinity Hub";
  await member
    .send(
      `Tu as été banni de **${guild.name}** par la protection anti-nuke.\nDate : <t:${Math.floor(Date.now() / 1000)}:F>\nRaison : ${reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
    )
    .catch(() => undefined);

  try {
    await member.ban({ reason });
  } catch (err) {
    SECURITY_NUKE_HANDLED.delete(cooldownKey);
    logger.error(
      { err, guildId: guild.id, userId: member.id },
      "Failed to ban anti-nuke executor",
    );
    return null;
  }

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "ban",
    targetId: member.id,
    targetTag: member.user.tag,
    moderatorId,
    moderatorTag,
    reason,
  });
  await logSanction(guild, {
    sanctionId,
    action: "ban",
    targetId: member.id,
    targetTag: member.user.tag,
    targetNickname: member.nickname,
    moderatorId,
    moderatorTag,
    reason,
  }).catch((err) =>
    logger.error({ err, guildId: guild.id, userId: member.id }, "Failed to log automated ban"),
  );

  return { sanctionId };
}

async function expireAutomatedTemporaryBan(
  guild: Guild,
  userId: string,
  expiresAt: number,
) {
  const key = `${guild.id}:${userId}`;
  try {
    await guild.members.unban(
      userId,
      `Fin du bannissement automatique temporaire (${new Date(expiresAt).toISOString()})`,
    );
    logger.info(
      { guildId: guild.id, userId },
      "Automated temporary ban expired",
    );
  } catch (err) {
    logger.warn(
      { err, guildId: guild.id, userId },
      "Failed to expire automated temporary ban",
    );
  } finally {
    SECURITY_TEMP_BAN_TIMEOUTS.delete(key);
  }
}

function scheduleAutomatedTemporaryBan(
  guild: Guild,
  userId: string,
  expiresAt: number,
) {
  const key = `${guild.id}:${userId}`;
  const previous = SECURITY_TEMP_BAN_TIMEOUTS.get(key);
  if (previous) {
    clearTimeout(previous);
  }
  SECURITY_TEMP_BAN_TIMEOUTS.set(
    key,
    scheduleAt(expiresAt, () => {
      void expireAutomatedTemporaryBan(guild, userId, expiresAt);
    }),
  );
}

async function applySecurityEscalation(
  guild: Guild,
  member: GuildMember,
  source: "anti-spam" | "anti-raid",
  detectionCount: number,
) {
  const escalation = securityEscalationForDetectionCount(detectionCount);
  if (!escalation) {
    return null;
  }

  const actionKey = `${guild.id}:${member.id}:${escalation.action}`;
  if (SECURITY_ESCALATION_HANDLED.has(actionKey)) {
    return null;
  }
  SECURITY_ESCALATION_HANDLED.add(actionKey);

  const durationMinutes = escalation.durationMinutes;
  const reason =
    durationMinutes === null
      ? `${source} : 5e détection de sécurité — bannissement permanent`
      : `${source} : ${detectionCount}e détection de sécurité — bannissement temporaire de 24 heures`;

  if (
    isProtectedSecurityTarget(guild, member) ||
    !member.bannable ||
    !guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)
  ) {
    SECURITY_ESCALATION_HANDLED.delete(actionKey);
    return null;
  }

  const moderator = guild.members.me;
  const moderatorId = moderator?.id ?? guild.client.user?.id ?? "system";
  const moderatorTag = moderator?.user.tag ?? guild.client.user?.tag ?? "Infinity Hub";
  const now = Date.now();
  const delivered = await member
    .send(
      durationMinutes === null
        ? `Tu as été banni définitivement de **${guild.name}** par la sécurité automatique.\nDate : <t:${Math.floor(now / 1000)}:F>\nRaison : ${reason}\n\nTu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`
        : `Tu as été banni temporairement de **${guild.name}** pendant **24 heures** par la sécurité automatique.\nDate : <t:${Math.floor(now / 1000)}:F>\nRaison : ${reason}\n\nTu seras automatiquement débanni à la fin de la période. Tu peux faire appel en rejoignant ce serveur : ${APPEAL_SERVER_INVITE}`,
    )
    .then(() => true)
    .catch(() => false);

  try {
    await member.ban({ reason });
  } catch (err) {
    SECURITY_ESCALATION_HANDLED.delete(actionKey);
    logger.error(
      { err, guildId: guild.id, userId: member.id, source },
      "Failed to apply security escalation ban",
    );
    return null;
  }

  const sanctionId = await saveSanction({
    guildId: guild.id,
    action: "ban",
    targetId: member.id,
    targetTag: member.user.tag,
    moderatorId,
    moderatorTag,
    reason,
    ...(durationMinutes === null ? {} : { durationMinutes }),
  });
  await logSanction(guild, {
    sanctionId,
    action: "ban",
    targetId: member.id,
    targetTag: member.user.tag,
    moderatorId,
    moderatorTag,
    reason,
    ...(durationMinutes === null ? {} : { durationMinutes }),
  }).catch((err) =>
    logger.error(
      { err, guildId: guild.id, userId: member.id },
      "Failed to log security escalation ban",
    ),
  );

  if (durationMinutes !== null) {
    scheduleAutomatedTemporaryBan(
      guild,
      member.id,
      now + durationMinutes * 60 * 1000,
    );
  }

  return { sanctionId, delivered, durationMinutes };
}

async function restoreAutomatedTemporaryBans(
  client: DiscordClient<boolean>,
) {
  const rows = await db
    .select()
    .from(discordSanctionsTable)
    .where(eq(discordSanctionsTable.action, "ban"))
    .orderBy(desc(discordSanctionsTable.createdAt));
  const latestBanByMember = new Map<string, (typeof rows)[number]>();

  for (const row of rows) {
    const key = `${row.guildId}:${row.targetId}`;
    if (!latestBanByMember.has(key)) {
      latestBanByMember.set(key, row);
    }
  }

  for (const row of latestBanByMember.values()) {
    if (
      row.durationMinutes !== SECURITY_TEMP_BAN_MINUTES ||
      (!row.reason.startsWith("anti-spam :") &&
        !row.reason.startsWith("anti-raid :"))
    ) {
      continue;
    }
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) {
      continue;
    }
    const expiresAt =
      row.createdAt.getTime() + SECURITY_TEMP_BAN_MINUTES * 60 * 1000;
    if (expiresAt <= Date.now()) {
      await expireAutomatedTemporaryBan(guild, row.targetId, expiresAt);
    } else {
      scheduleAutomatedTemporaryBan(guild, row.targetId, expiresAt);
    }
  }
}

// Commandes de modération à masquer pour le rôle "membres" dans le
// sélecteur de commandes Discord (elles restent visibles pour tous les
// autres rôles/membres sans restriction particulière ; l'accès réel reste
// de toute façon vérifié en interne via COMMAND_ROLE_IDS / ADMIN_COMMANDS /
// OWNER_COMMANDS, ceci ne fait que les cacher visuellement aux membres).
async function logToGuild(
  guild: Guild,
  embed: EmbedBuilder | EmbedBuilder[],
  category: keyof typeof LOG_CHANNEL_IDS,
  files?: AttachmentBuilder[],
) {
  const settings = await getGuildSettings(guild.id);
  const channelId = settings.logChannels[category] ?? null;
  const channel = guild.channels.cache.find(
    (candidate) =>
      (channelId
        ? candidate.id === channelId
        : candidate.name.toLowerCase() === categoryToChannelName(category)) &&
      (candidate.type === ChannelType.GuildText ||
        candidate.type === ChannelType.GuildAnnouncement),
  ) as TextChannel | undefined;

  if (!channel) {
    logger.warn(
      { guildId: guild.id, category, channelId },
      "Discord log channel not found",
    );
    return;
  }

  try {
    await channel.send({
      embeds: Array.isArray(embed) ? embed : [embed],
      files,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Failed to send Discord log");
  }
}

function formatDate(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}

// Envoie un embed de démarrage dans le salon "startup" de chaque serveur.
// Se déclenche à chaque fois que le processus du bot démarre (premier
// lancement comme redémarrages suivants), puisque clientReady se redéclenche
// à chaque reconnexion complète du client.
async function logBotStartup(readyClient: DiscordClient<true>) {
  const embed = new EmbedBuilder()
    .setTitle("🟢 Bot démarré")
    .setColor(0x2ecc71)
    .addFields(
      { name: "Bot", value: readyClient.user.tag, inline: true },
      {
        name: "Serveurs",
        value: String(readyClient.guilds.cache.size),
        inline: true,
      },
      { name: "Démarré", value: formatDate(new Date()), inline: true },
    )
    .setTimestamp();

  for (const guild of readyClient.guilds.cache.values()) {
    await logToGuild(guild, embed, "startup").catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Failed to log bot startup",
      );
    });
  }
}

// Envoie un embed d'arrêt dans le même salon que le log de démarrage.
// Ne fonctionne que pour un arrêt "propre" (SIGINT/SIGTERM, ex. redéploiement
// ou arrêt manuel) : un crash brutal ou un SIGKILL ne laisse pas le temps au
// process d'envoyer quoi que ce soit avant de se terminer.
async function logBotShutdown(client: DiscordClient<boolean>, signal: string) {
  const embed = new EmbedBuilder()
    .setTitle("🔴 Bot arrêté")
    .setColor(0xe74c3c)
    .addFields(
      { name: "Bot", value: client.user?.tag ?? "Inconnu", inline: true },
      { name: "Signal", value: signal, inline: true },
      { name: "Arrêté", value: formatDate(new Date()), inline: true },
    )
    .setTimestamp();

  for (const guild of client.guilds.cache.values()) {
    await logToGuild(guild, embed, "startup").catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Failed to log bot shutdown",
      );
    });
  }
}

let isShuttingDown = false;

function registerShutdownLogging(client: DiscordClient<boolean>) {
  const handleSignal = (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    void (async () => {
      logger.info({ signal }, "Discord bot shutting down");

      await logBotShutdown(client, signal).catch((err) => {
        logger.error({ err }, "Failed to log bot shutdown");
      });

      client.destroy();
      process.exit(0);
    })();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

function categoryToChannelName(category: keyof typeof LOG_CHANNEL_IDS) {
  if (category === "messages") {
    return "messages";
  }

  if (category === "sanctions") {
    return "sanctions";
  }

  if (category === "arrivals") {
    return "douane";
  }

  if (category === "departures") {
    return "douane";
  }

  if (category === "locks") {
    return "locks";
  }

  if (category === "tempVoice") {
    return "vocaux-temporaires";
  }

  if (category === "customRoles") {
    return "roles-persos";
  }

  if (category === "leaderboard") {
    return "leaderboard";
  }

  if (category === "polls") {
    return "sondages";
  }

  if (category === "games") {
    return "jeux";
  }

  if (category === "startup") {
    return "demarrage";
  }

  if (category === "features") {
    return "fonctionnalites";
  }

  return LOG_CHANNEL_NAME;
}

// Salon unique dans lequel /announce et /poll publient désormais (plus de
// sélecteur : le salon est fixe).
const ANNOUNCE_POLL_CHANNEL_ID =
  process.env.DISCORD_ANNOUNCE_POLL_CHANNEL_ID ?? "1517583221649313822";

// Construit /announce et /poll (plus de sélecteur de salon : elles publient
// toujours dans ANNOUNCE_POLL_CHANNEL_ID).
function buildAnnouncePollCommands(_guild: Guild) {
  return [
    new SlashCommandBuilder()
      .setName("announce")
      .setDescription("Envoie une annonce dans un salon (animateurs).")
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Contenu de l'annonce.")
          .setRequired(true)
          .setMaxLength(4000),
      )
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("Titre de l'annonce (optionnel)."),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Rôle à mentionner (optionnel)."),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("poll")
      .setDescription("Lance un sondage à réactions (animateurs).")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("La question du sondage.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("option1")
          .setDescription("Choix n°1.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("option2")
          .setDescription("Choix n°2.")
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("duration")
          .setDescription("Durée en minutes avant clôture automatique.")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10080),
      )
      .addStringOption((option) =>
        option.setName("option3").setDescription("Choix n°3 (optionnel)."),
      )
      .addStringOption((option) =>
        option.setName("option4").setDescription("Choix n°4 (optionnel)."),
      )
      .addStringOption((option) =>
        option.setName("option5").setDescription("Choix n°5 (optionnel)."),
      )
      .toJSON(),
  ];
}

export async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN est requis pour démarrer le bot Discord.",
    );
  }

  const client = new Client({
    partials: [Partials.Message],
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
  activeDiscordClient = client;

  registerCommandHandlers(client);
  registerGuildLogs(client);
  registerSecurityAndOnboarding(client);
  registerAntiNuke(client);
  registerVoiceHub(client);
  registerMentionResponder(client);
  registerLevelingSystem(client);
  registerAutoReactChannel(client);
  registerPrefixCommands(client);
  registerShutdownLogging(client);

  client.once("clientReady", async (readyClient) => {
    await restoreSecurityLockdowns(readyClient).catch((err) => {
      logger.error({ err }, "Failed to restore security lockdowns");
    });
    await reconcileCosmoMissions().catch((err) => {
      logger.error({ err }, "Failed to reconcile Cosmo missions");
    });

    for (const guild of readyClient.guilds.cache.values()) {
      await guild.channels.fetch().catch((err) => {
        logger.error(
          { err, guildId: guild.id },
          "Failed to fetch guild channels before registering commands",
        );
      });
      const guildSettings = await getGuildSettings(guild.id);
      await saveGuildSettings(guild.id, guildSettings).catch((err) => {
        logger.error(
          { err, guildId: guild.id },
          "Failed to initialize guild settings",
        );
      });
      await reconcileGuildLevelTierRoles(guild, false).catch((err) => {
        logger.error(
          { err, guildId: guild.id },
          "Failed to restore cached level tier roles",
        );
      });
      await guild.commands.set(
        enabledCommands.filter(
          (command) => command.name === "owner" || command.name === "say",
        ),
      );
      await ensureCosmoResources(guild).catch((err) => {
        logger.error(
          { err, guildId: guild.id },
          "Failed to ensure Cosmo Shield resources",
        );
      });
    }

    await restoreCustomRoles(readyClient);
    await restoreAutomatedTemporaryBans(readyClient).catch((err) => {
      logger.error({ err }, "Failed to restore automated temporary bans");
    });

    scheduleWeeklyGlobalMissions(readyClient);

    readyClient.user.setPresence({
      status: "online",
      activities: [
        {
          name: BOT_STATUS_TEXT,
          type: ActivityType.Streaming,
          url: BOT_STATUS_URL,
        },
      ],
    });

    logger.info(
      { bot: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
      "Discord bot connected and commands registered",
    );

    await logBotStartup(readyClient);

    scheduleMonthlyLeaderboard(readyClient);
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}

// --- Système de niveaux ---

async function getUserXp(guildId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ xp: discordLevelsTable.xp })
    .from(discordLevelsTable)
    .where(
      and(
        eq(discordLevelsTable.guildId, guildId),
        eq(discordLevelsTable.userId, userId),
      ),
    );

  return row?.xp ?? 0;
}

async function setUserXp(
  guildId: string,
  userId: string,
  xp: number,
): Promise<void> {
  const safeXp = Math.max(0, xp);

  await db
    .insert(discordLevelsTable)
    .values({ guildId, userId, xp: safeXp } satisfies NewDiscordLevel)
    .onConflictDoUpdate({
      target: [discordLevelsTable.guildId, discordLevelsTable.userId],
      set: { xp: safeXp, updatedAt: new Date() },
    });
  await syncXpBadges(guildId, userId, safeXp).catch((err) => {
    logger.error({ err, guildId, userId }, "Failed to synchronize XP badges");
  });
}

async function getUserRank(guildId: string, xp: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discordLevelsTable)
    .where(
      and(
        eq(discordLevelsTable.guildId, guildId),
        gt(discordLevelsTable.xp, xp),
      ),
    );

  return Number(row?.count ?? 0) + 1;
}

async function announceLevelUp(
  guild: Guild,
  member: GuildMember,
  level: number,
) {
  const settings = await getGuildSettings(guild.id);
  const levelUpChannelId = settings.channelIds.levelUp;
  const channel = await guild.client.channels
    .fetch(levelUpChannelId ?? "")
    .catch(() => null);

  if (!channel || !("send" in channel)) {
    logger.warn(
      { guildId: guild.id, channelId: levelUpChannelId },
      "Level-up channel not found or not text-based",
    );
    return;
  }

  const totalXp = await getUserXp(guild.id, member.id);
  const tier = levelTiersForLevel(
    level,
    LEVEL_TIER_SIZE,
    MAX_LEVEL_TIERS,
  ).at(-1);
  const roleId = tier ? settings.levelTierRoleIds[tier] : null;
  const role = roleId
    ? await guild.roles.fetch(roleId).catch(() => null)
    : null;
  const roleValue = role
    ? `${role} (palier ${tier})`
    : "Aucun rôle configuré pour ce palier.";

  const embed = new EmbedBuilder()
    .setTitle("🎉 Palier atteint !")
    .setColor(0xf1c40f)
    .addFields(
      { name: "Membre", value: `${member}`, inline: true },
      { name: "Niveau", value: String(level), inline: true },
      { name: "XP total", value: String(totalXp), inline: true },
      { name: "Rôle reçu", value: roleValue, inline: false },
    )
    .setTimestamp();

  await channel
    .send({
      content: `${member}`,
      embeds: [embed],
      allowedMentions: { users: [member.id] },
    })
    .catch((err) => {
      logger.error(
        { err, userId: member.id, level },
        "Failed to announce level up",
      );
    });
}

async function removeLevelTierRoleFromMembers(
  guild: Guild,
  roleId: string | null,
  reason: string,
  fetchMembers = true,
) {
  if (!roleId) {
    return;
  }

  const members = fetchMembers
    ? await guild.members.fetch().catch((err) => {
        logger.warn(
          { err, guildId: guild.id },
          "Failed to fetch members for level role cleanup",
        );
        return null;
      })
    : guild.members.cache;

  if (!members) return;

  for (const member of members.values()) {
    if (!member.roles.cache.has(roleId)) {
      continue;
    }
    await member.roles.remove(roleId, reason).catch((err) => {
      logger.warn(
        { err, guildId: guild.id, userId: member.id, roleId },
        "Failed to remove obsolete level tier role",
      );
    });
  }
}

async function syncMemberLevelTierRoles(
  guild: Guild,
  member: GuildMember,
  level: number,
  reason = "Synchronisation des rôles de niveau",
): Promise<{ rolesAdded: number; rolesRemoved: number; errors: number }> {
  const settings = await getGuildSettings(guild.id);
  const tierNumbers = levelTiersForLevel(
    level,
    LEVEL_TIER_SIZE,
    MAX_LEVEL_TIERS,
  );
  const expectedRoleIds = new Set(
    tierNumbers
      .map((tier) => settings.levelTierRoleIds[tier])
      .filter((roleId): roleId is string => Boolean(roleId)),
  );
  const configuredRoleIds = new Set(configuredLevelTierRoleIds(settings));
  const rolesToAdd = Array.from(expectedRoleIds).filter(
    (roleId) => !member.roles.cache.has(roleId),
  );
  const rolesToRemove = Array.from(configuredRoleIds).filter(
    (roleId) => !expectedRoleIds.has(roleId) && member.roles.cache.has(roleId),
  );

  let rolesAdded = 0;
  let rolesRemoved = 0;
  let errors = 0;

  if (rolesToRemove.length > 0) {
    try {
      await member.roles.remove(rolesToRemove, reason);
      rolesRemoved = rolesToRemove.length;
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, guildId: guild.id, userId: member.id, rolesToRemove },
        "Failed to remove level tier roles",
      );
    }
  }
  if (rolesToAdd.length > 0) {
    try {
      await member.roles.add(rolesToAdd, reason);
      rolesAdded = rolesToAdd.length;
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, guildId: guild.id, userId: member.id, rolesToAdd },
        "Failed to add level tier roles",
      );
    }
  }

  return { rolesAdded, rolesRemoved, errors };
}

async function reconcileGuildLevelTierRoles(
  guild: Guild,
  fetchMembers = true,
): Promise<{
  configuredRoleCount: number;
  membersAnalyzed: number;
  rolesAdded: number;
  rolesRemoved: number;
  errors: number;
}> {
  const members = fetchMembers
    ? await guild.members.fetch()
    : guild.members.cache;
  const rows = await db
    .select({
      userId: discordLevelsTable.userId,
      xp: discordLevelsTable.xp,
    })
    .from(discordLevelsTable)
    .where(eq(discordLevelsTable.guildId, guild.id));
  const xpByUserId = new Map(rows.map((row) => [row.userId, row.xp]));
  const settings = await getGuildSettings(guild.id);
  const configuredRoleIds = configuredLevelTierRoleIds(settings);

  if (configuredRoleIds.length === 0) {
    return {
      configuredRoleCount: 0,
      membersAnalyzed: 0,
      rolesAdded: 0,
      rolesRemoved: 0,
      errors: 0,
    };
  }

  const result = {
    configuredRoleCount: configuredRoleIds.length,
    membersAnalyzed: 0,
    rolesAdded: 0,
    rolesRemoved: 0,
    errors: 0,
  };

  for (const member of members.values()) {
    const level = calculateLevel(xpByUserId.get(member.id) ?? 0).level;
    result.membersAnalyzed += 1;
    try {
      const memberResult = await syncMemberLevelTierRoles(guild, member, level);
      result.rolesAdded += memberResult.rolesAdded;
      result.rolesRemoved += memberResult.rolesRemoved;
      result.errors += memberResult.errors;
    } catch (err) {
      result.errors += 1;
      logger.warn(
        { err, guildId: guild.id, userId: member.id },
        "Failed to reconcile member level tier roles",
      );
    }
  }

  return result;
}

// Accorde le rôle de palier et annonce chaque palier franchi entre
// `previousLevel` (exclu) et `newLevel` (inclus) — gère aussi le cas où un
// admin fait sauter plusieurs paliers d'un coup via /add-xp ou /set-xp.
async function grantLevelUpRewards(
  guild: Guild,
  member: GuildMember,
  previousLevel: number,
  newLevel: number,
) {
  await syncMemberLevelTierRoles(guild, member, newLevel);

  if (newLevel <= previousLevel) {
    return;
  }

  for (let level = previousLevel + 1; level <= newLevel; level++) {
    if (level !== 1 && level % LEVEL_TIER_SIZE !== 0) {
      continue;
    }
    await announceLevelUp(guild, member, level);
  }
}

function registerLevelingSystem(client: DiscordClient<boolean>) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    const cooldownKey = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const lastGain = XP_COOLDOWNS.get(cooldownKey) ?? 0;

    if (now - lastGain < XP_MESSAGE_COOLDOWN_MS) {
      return;
    }

    XP_COOLDOWNS.set(cooldownKey, now);

    try {
      const gained =
        Math.floor(
          Math.random() * (XP_MAX_PER_MESSAGE - XP_MIN_PER_MESSAGE + 1),
        ) + XP_MIN_PER_MESSAGE;

      const currentXp = await getUserXp(message.guild.id, message.author.id);
      const previousLevel = calculateLevel(currentXp).level;
      const newXp = currentXp + gained;

      await setUserXp(message.guild.id, message.author.id, newXp);

      const newLevel = calculateLevel(newXp).level;

      if (newLevel !== previousLevel) {
        const member = await message.guild.members
          .fetch(message.author.id)
          .catch(() => null);

        if (member) {
          await grantLevelUpRewards(
            message.guild,
            member,
            previousLevel,
            newLevel,
          );
        }
      }
    } catch (err) {
      logger.error(
        { err, userId: message.author.id },
        "Failed to process message XP gain",
      );
    }
  });
}

async function rankCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const target = interaction.options.getUser("user") ?? interaction.user;
  const xp = await getUserXp(guild.id, target.id);
  const { level, xpIntoLevel, xpForNext } = calculateLevel(xp);
  const rank = await getUserRank(guild.id, xp);

  const embed = new EmbedBuilder()
    .setTitle(`Niveau de ${target.tag}`)
    .setColor(0x3498db)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "Niveau", value: String(level), inline: true },
      { name: "XP total", value: String(xp), inline: true },
      { name: "Rang", value: `#${rank}`, inline: true },
      {
        name: "Progression",
        value: `${xpIntoLevel} / ${xpForNext} XP`,
        inline: false,
      },
    );

  await interaction.reply({ embeds: [embed] });
}

async function leaderboardCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const limit = interaction.options.getInteger("limit") ?? 10;

  const rows = await db
    .select()
    .from(discordLevelsTable)
    .where(eq(discordLevelsTable.guildId, guild.id))
    .orderBy(desc(discordLevelsTable.xp))
    .limit(limit);

  if (rows.length === 0) {
    await interaction.reply({
      content: "Personne n'a encore gagné d'XP sur ce serveur.",
    });
    return;
  }

  const description = rows
    .map((row, index) => {
      const { level } = calculateLevel(row.xp);
      return `**${index + 1}.** <@${row.userId}> — Niveau ${level} (${row.xp} XP)`;
    })
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Classement — ${guild.name}`)
    .setColor(0xf1c40f)
    .setDescription(description);

  await interaction.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

// setTimeout refuse tout délai supérieur à ~24,8 jours (2^31 - 1 ms) : au-delà,
// Node l'exécute immédiatement au lieu d'attendre. Cette fonction découpe
// donc les longs délais (ex. "jusqu'au 1er du mois prochain") en plusieurs
// setTimeout enchaînés tant que nécessaire.
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;

function scheduleAt(targetTime: number, callback: () => void) {
  const delay = targetTime - Date.now();

  if (delay <= MAX_SAFE_TIMEOUT_MS) {
    return setTimeout(callback, Math.max(delay, 0));
  }

  return setTimeout(() => scheduleAt(targetTime, callback), MAX_SAFE_TIMEOUT_MS);
}

// Calcule le dernier samedi du mois à midi UTC.
// Programme (et reprogramme indéfiniment, mois après mois) le classement
// mensuel. À appeler une seule fois au démarrage du bot.
function scheduleMonthlyLeaderboard(client: DiscordClient<boolean>) {
  const nextRun = getNextMonthlyLeaderboardRun();

  scheduleAt(nextRun, () => {
    runMonthlyLeaderboard(client)
      .catch((err) => {
        logger.error({ err }, "Monthly leaderboard job failed");
      })
      .finally(() => {
        scheduleMonthlyLeaderboard(client);
      });
  });

  logger.info(
    { nextRun: new Date(nextRun).toISOString() },
    "Monthly leaderboard scheduled",
  );
}

function buildGlobalMissionsMessage(
  missions: Array<{
    id: number;
    title: string;
    description: string;
    targetCount: number;
    rewardXp: number;
    endsAt: Date;
  }>,
  weekStart: Date,
) {
  if (missions.length === 0) {
    return {
      content: [
        "🌍 **Missions globales de la semaine**",
        `Semaine du ${formatDate(weekStart)}`,
        "",
        "Aucune mission globale active pour le moment.",
      ].join("\n"),
      embeds: [],
      components: [],
    };
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < missions.length; index += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...missions.slice(index, index + 5).map((mission) =>
          new ButtonBuilder()
            .setCustomId(`${COSMO_MISSION_JOIN_PREFIX}${mission.id}`)
            .setLabel(`Participer à CM-${mission.id}`)
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }

  return {
    content: [
      "🌍 **Missions globales de la semaine**",
      `Semaine du ${formatDate(weekStart)}`,
      "Participe avec les boutons ci-dessous. Les missions restent consultables dans le salon missions.",
    ].join("\n"),
    embeds: missions.map((mission) =>
      new EmbedBuilder()
        .setTitle(`🎯 CM-${mission.id} — ${mission.title}`)
        .setDescription(mission.description)
        .setColor(0x3498db)
        .addFields(
          {
            name: "Objectif par membre",
            value: String(mission.targetCount),
            inline: true,
          },
          {
            name: "Récompense",
            value: `${mission.rewardXp} XP`,
            inline: true,
          },
          { name: "Fin", value: formatDate(mission.endsAt), inline: true },
        )
        .setTimestamp(),
    ),
    components,
  };
}

async function publishGlobalMissionsForGuild(
  client: DiscordClient<boolean>,
  guild: Guild,
  weekStart: Date,
  force = false,
) {
  const resources = await ensureCosmoResources(guild);
  let publicationId: number | null = null;

  if (!force) {
    const [publication] = await db
      .insert(discordMissionPublicationsTable)
      .values({
        guildId: guild.id,
        weekStart,
        channelId: resources.globalMissionsChannelId,
      })
      .onConflictDoNothing()
      .returning();

    if (!publication) {
      return;
    }
    publicationId = publication.id;
  }

  const missions = await db
    .select({
      id: discordMissionsTable.id,
      title: discordMissionsTable.title,
      description: discordMissionsTable.description,
      targetCount: discordMissionsTable.targetCount,
      rewardXp: discordMissionsTable.rewardXp,
      endsAt: discordMissionsTable.endsAt,
    })
    .from(discordMissionsTable)
    .where(
      and(
        eq(discordMissionsTable.guildId, guild.id),
        eq(discordMissionsTable.status, "active"),
        lte(discordMissionsTable.startsAt, new Date()),
        gt(discordMissionsTable.endsAt, new Date()),
      ),
    )
    .orderBy(asc(discordMissionsTable.endsAt))
    .limit(10);

  const channel = guild.channels.cache.get(resources.globalMissionsChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    if (publicationId !== null) {
      await db
        .delete(discordMissionPublicationsTable)
        .where(eq(discordMissionPublicationsTable.id, publicationId));
    }
    throw new Error("Le salon des missions globales est introuvable.");
  }

  try {
    const message = await channel.send({
      ...buildGlobalMissionsMessage(missions, weekStart),
      allowedMentions: { parse: [] },
    });
    if (publicationId !== null) {
      await db
        .update(discordMissionPublicationsTable)
        .set({ messageId: message.id })
        .where(eq(discordMissionPublicationsTable.id, publicationId));
    }
    logger.info(
      {
        guildId: guild.id,
        weekStart: weekStart.toISOString(),
        missions: missions.length,
        forced: force,
      },
      "Global Cosmo missions published",
    );
  } catch (err) {
    if (publicationId !== null) {
      await db
        .delete(discordMissionPublicationsTable)
        .where(eq(discordMissionPublicationsTable.id, publicationId))
        .catch(() => undefined);
    }
    throw err;
  }
}

async function runWeeklyGlobalMissions(client: DiscordClient<boolean>) {
  const { weekStart } = getCurrentWeeklyMissionPeriod();
  for (const guild of client.guilds.cache.values()) {
    await publishGlobalMissionsForGuild(client, guild, weekStart).catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Weekly global Cosmo missions failed for this guild",
      );
    });
  }
}

function scheduleWeeklyGlobalMissions(client: DiscordClient<boolean>) {
  const nextRun = getNextWeeklyMissionRun();

  scheduleAt(nextRun, () => {
    runWeeklyGlobalMissions(client)
      .catch((err) => {
        logger.error({ err }, "Weekly global Cosmo missions job failed");
      })
      .finally(() => {
        scheduleWeeklyGlobalMissions(client);
      });
  });

  logger.info(
    { nextRun: new Date(nextRun).toISOString() },
    "Weekly global Cosmo missions scheduled",
  );
}

async function runMonthlyLeaderboard(client: DiscordClient<boolean>) {
  for (const guild of client.guilds.cache.values()) {
    await runMonthlyLeaderboardForGuild(client, guild).catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Monthly leaderboard failed for this guild",
      );
    });
  }
}

async function runMonthlyLeaderboardForGuild(
  client: DiscordClient<boolean>,
  guild: Guild,
) {
  const settings = await getGuildSettings(guild.id);
  const leaderboardChannelId = settings.channelIds.monthlyLeaderboard;
  const monthlyPingRoleId = settings.roleIds.monthlyLeaderboardPing;
  const topXpRoleId = settings.roleIds.topXp;
  const rows = await db
    .select()
    .from(discordLevelsTable)
    .where(eq(discordLevelsTable.guildId, guild.id))
    .orderBy(desc(discordLevelsTable.xp))
    .limit(MONTHLY_LEADERBOARD_SIZE);

  if (rows.length === 0) {
    logger.info(
      { guildId: guild.id },
      "Monthly leaderboard skipped: no XP data",
    );
    return { sent: false, reason: "no-xp-data" as const };
  }

  const channel = await client.channels
    .fetch(leaderboardChannelId ?? "")
    .catch(() => null);

  if (!channel || !("send" in channel)) {
    logger.warn(
      { channelId: leaderboardChannelId },
      "Monthly leaderboard channel not found or not text-based",
    );
    return { sent: false, reason: "channel-not-found" as const };
  }

  // --- Attribution du rôle Top 1 ---
  let roleAssignmentNote =
    "Configure `role.topXp` avec `*serverconfig` pour attribuer automatiquement un rôle au Top 1.";
  const winnerId = rows[0]!.userId;

  if (topXpRoleId) {
    const topRole = await guild.roles.fetch(topXpRoleId).catch(() => null);

    if (!topRole) {
      logger.warn(
        { roleId: topXpRoleId, guildId: guild.id },
        "Top XP role not found",
      );
      roleAssignmentNote = "⚠️ Le rôle Top 1 configuré est introuvable sur ce serveur.";
    } else {
      // Retire le rôle à son ou ses ancien(s) détenteur(s).
      for (const previousHolder of topRole.members.values()) {
        if (previousHolder.id === winnerId) {
          continue;
        }

        await previousHolder.roles.remove(topRole).catch((err) => {
          logger.error(
            { err, userId: previousHolder.id, roleId: topRole.id },
            "Failed to remove previous top XP role holder",
          );
        });
      }

      const winnerMember = await guild.members.fetch(winnerId).catch(() => null);

      if (winnerMember) {
        await winnerMember.roles.add(topRole).catch((err) => {
          logger.error(
            { err, userId: winnerId, roleId: topRole.id },
            "Failed to assign top XP role to new winner",
          );
        });
        roleAssignmentNote = `Le rôle ${topRole} a été attribué à <@${winnerId}> pour le mois à venir.`;
      } else {
        roleAssignmentNote = "⚠️ Le membre en tête du classement n'a pas pu être retrouvé sur le serveur.";
      }
    }
  }

  const medals = ["🥇", "🥈", "🥉"];
  const description = rows
    .map((row, index) => {
      const { level } = calculateLevel(row.xp);
      const rank = medals[index] ?? `**${index + 1}.**`;
      return `${rank} <@${row.userId}> — Niveau ${level} (${row.xp} XP)`;
    })
    .join("\n");

  const monthLabel = new Date().toLocaleString("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Classement mensuel — ${monthLabel}`)
    .setColor(0xf1c40f)
    .setDescription(description)
    .setFooter({ text: "Classement mensuel automatique." })
    .setTimestamp();

  const contentLines = [
    monthlyPingRoleId
      ? `<@&${monthlyPingRoleId}>`
      : null,
    roleAssignmentNote,
  ].filter((line): line is string => Boolean(line));

  await channel
    .send({
      content: contentLines.length > 0 ? contentLines.join("\n") : undefined,
      embeds: [embed],
      allowedMentions: {
        roles: [
          ...(monthlyPingRoleId
            ? [monthlyPingRoleId]
            : []),
          ...(topXpRoleId ? [topXpRoleId] : []),
        ],
        users: [winnerId],
      },
    })
    .catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Failed to send monthly leaderboard announcement",
      );
    });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🏆 Classement mensuel envoyé")
      .setColor(0xf1c40f)
      .addFields(
        { name: "Salon", value: `<#${leaderboardChannelId}>`, inline: true },
        { name: "Top 1", value: `<@${winnerId}>\n\`${winnerId}\``, inline: true },
        { name: "Membres classés", value: String(rows.length), inline: true },
      )
      .setTimestamp(),
    "leaderboard",
  );

  return { sent: true as const };
}

async function forceLeaderboardCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  await interaction.deferReply();

  const result = await runMonthlyLeaderboardForGuild(
    interaction.client,
    guild,
  ).catch((err) => {
    logger.error(
      { err, guildId: guild.id },
      "Manual monthly leaderboard trigger failed",
    );
    return { sent: false, reason: "error" as const };
  });

  if (result.sent) {
    await interaction.editReply(
      `✅ Classement mensuel envoyé dans <#${(await getGuildSettings(guild.id)).channelIds.monthlyLeaderboard}>.`,
    );
    return;
  }

  const reasonText =
    result.reason === "no-xp-data"
      ? "Aucune donnée d’XP enregistrée pour ce serveur."
      : result.reason === "channel-not-found"
        ? `Le salon configuré pour le classement mensuel est introuvable ou inaccessible.`
        : "Une erreur est survenue, vérifie les logs du bot.";

  await interaction.editReply(`❌ Classement non envoyé. ${reasonText}`);
}

async function resetMemberCommand(interaction: ChatInputCommandInteraction) {
  if (!isStrictBotOwnerInteraction(interaction)) {
    await interaction.reply({
      content: "Cette commande est réservée au propriétaire principal du bot.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const memberUser = interaction.options.getUser("member", true);
  const resetType = interaction.options.getString("reset", true);
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content:
        "Réinitialisation annulée. Relance `*resetmember` avec `confirm: true` pour confirmer.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const resetLevel = resetType === "niveau" || resetType === "all";
  const resetSanctions = resetType === "sanctions" || resetType === "all";
  const resetMissions = resetType === "missions" || resetType === "all";
  const resetCustomRoles = resetType === "rolesperso" || resetType === "all";
  const resetLabels: Record<string, string> = {
    niveau: "niveau et XP",
    sanctions: "sanctions",
    missions: "progression des missions",
    rolesperso: "rôles personnalisés",
    all: "toutes les données membre sauf les signalements",
  };
  const removed: string[] = [];

  if (resetLevel) {
    await db
      .delete(discordLevelsTable)
      .where(
        and(
          eq(discordLevelsTable.guildId, guild.id),
          eq(discordLevelsTable.userId, memberUser.id),
        ),
      );
    XP_COOLDOWNS.delete(`${guild.id}:${memberUser.id}`);

    const member = await guild.members.fetch(memberUser.id).catch(() => null);
    const tierRoleIds = configuredLevelTierRoleIds(await getGuildSettings(guild.id));
    if (member && tierRoleIds.length > 0) {
      await member.roles
        .remove(
          tierRoleIds.filter((roleId) => member.roles.cache.has(roleId)),
          "Réinitialisation du niveau par le propriétaire du bot",
        )
        .catch((err) => {
          logger.warn(
            { err, guildId: guild.id, userId: memberUser.id },
            "Failed to remove level roles during member reset",
          );
        });
    }
    removed.push("niveau et XP");
  }

  if (resetSanctions) {
    await db
      .delete(discordSanctionsTable)
      .where(
        and(
          eq(discordSanctionsTable.guildId, guild.id),
          eq(discordSanctionsTable.targetId, memberUser.id),
        ),
      );
    const member = await guild.members.fetch(memberUser.id).catch(() => null);
    await member
      ?.timeout(null, "Réinitialisation des sanctions par le propriétaire du bot")
      .catch((err) => {
        logger.warn(
          { err, guildId: guild.id, userId: memberUser.id },
          "Failed to clear member timeout during reset",
        );
      });
    removed.push("sanctions");
  }

  if (resetMissions) {
    await db
      .delete(discordMissionProgressTable)
      .where(
        and(
          eq(discordMissionProgressTable.guildId, guild.id),
          eq(discordMissionProgressTable.userId, memberUser.id),
        ),
      );
    const member = await guild.members.fetch(memberUser.id).catch(() => null);
    if (member) {
      const resources = await ensureCosmoResources(guild);
      if (member.roles.cache.has(resources.guardianRoleId)) {
        await member.roles
          .remove(
            resources.guardianRoleId,
            "Réinitialisation de la progression Cosmo par le propriétaire du bot",
          )
          .catch((err) => {
            logger.warn(
              { err, guildId: guild.id, userId: memberUser.id },
              "Failed to remove Cosmo Guardian role during member reset",
            );
          });
      }
    }
    removed.push("progression des missions");
  }

  if (resetCustomRoles) {
    const customRoles = Array.from(ACTIVE_CUSTOM_ROLES.values()).filter(
      (state) =>
        state.guildId === guild.id && state.ownerId === memberUser.id,
    );
    for (const state of customRoles) {
      await expireCustomRole(interaction.client, state.roleId, true, {
        tag: interaction.user.tag,
        id: interaction.user.id,
      });
    }
    await db
      .delete(discordCustomRolesTable)
      .where(
        and(
          eq(discordCustomRolesTable.guildId, guild.id),
          eq(discordCustomRolesTable.ownerId, memberUser.id),
        ),
      );
    removed.push(`rôles personnalisés (${customRoles.length})`);
  }

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🧹 Données membre réinitialisées")
      .setColor(0xe67e22)
      .addFields(
        {
          name: "Membre",
          value: `${memberUser.tag}\n\`${memberUser.id}\``,
          inline: true,
        },
        {
          name: "Reset",
          value: resetLabels[resetType] ?? resetType,
          inline: true,
        },
        {
          name: "Effectué par",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
        },
      )
      .setTimestamp(),
    "leaderboard",
  );

  await interaction.editReply(
    `✅ Réinitialisation terminée pour **${memberUser.tag}** : ${removed.join(", ")}.`,
  );
}

async function resetLevelsCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
      ephemeral: true,
    });
    return;
  }

  const confirm = interaction.options.getBoolean("confirm", true);
  if (!confirm) {
    await interaction.reply({
      content:
        "Réinitialisation annulée. Relance `*resetlevels` avec `confirm: true` pour confirmer.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const existingRows = await db
    .select({ userId: discordLevelsTable.userId })
    .from(discordLevelsTable)
    .where(eq(discordLevelsTable.guildId, guild.id));

  await db
    .delete(discordLevelsTable)
    .where(eq(discordLevelsTable.guildId, guild.id));

  const cooldownPrefix = `${guild.id}:`;
  for (const key of XP_COOLDOWNS.keys()) {
    if (key.startsWith(cooldownPrefix)) {
      XP_COOLDOWNS.delete(key);
    }
  }

  const tierRoleIds = configuredLevelTierRoleIds(await getGuildSettings(guild.id));
  let removedTierRoles = 0;

  if (tierRoleIds.length > 0) {
    const members = await guild.members.fetch().catch((err) => {
      logger.error(
        { err, guildId: guild.id },
        "Failed to fetch members while resetting levels",
      );
      return null;
    });

    if (members) {
      for (const member of members.values()) {
        const rolesToRemove = tierRoleIds.filter((roleId) =>
          member.roles.cache.has(roleId),
        );

        if (rolesToRemove.length === 0) {
          continue;
        }

        await member.roles
          .remove(
            rolesToRemove,
            "Réinitialisation globale des niveaux par le propriétaire du bot",
          )
          .then(() => {
            removedTierRoles += rolesToRemove.length;
          })
          .catch((err) => {
            logger.warn(
              { err, guildId: guild.id, userId: member.id, rolesToRemove },
              "Failed to remove level tier roles during reset",
            );
          });
      }
    }
  }

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("🔄 Niveaux réinitialisés")
      .setColor(0xe74c3c)
      .addFields(
        {
          name: "Membres avec des données XP",
          value: String(existingRows.length),
          inline: true,
        },
        {
          name: "Rôles de paliers retirés",
          value: String(removedTierRoles),
          inline: true,
        },
        {
          name: "Effectué par",
          value: `${interaction.user.tag}\n\`${interaction.user.id}\``,
        },
      )
      .setTimestamp(),
    "leaderboard",
  );

  await interaction.editReply(
    `✅ Niveaux réinitialisés pour ce serveur. ${existingRows.length} entrée(s) XP supprimée(s) et ${removedTierRoles} rôle(s) de palier retiré(s).`,
  );
}

// Un admin doit préciser `level` OU `xp`, jamais les deux, jamais aucun des
// deux — Discord ne permet pas nativement d'exprimer un "ou exclusif" au
// niveau des options de commande, donc la validation se fait ici.
async function resolveLevelOrXpOption(
  interaction: ChatInputCommandInteraction,
): Promise<
  { mode: "level"; value: number } | { mode: "xp"; value: number } | null
> {
  const level = interaction.options.getInteger("level");
  const xp = interaction.options.getInteger("xp");

  if (level === null && xp === null) {
    await interaction.reply({
      content: "Précise soit `level`, soit `xp`.",
      ephemeral: true,
    });
    return null;
  }

  if (level !== null && xp !== null) {
    await interaction.reply({
      content: "Précise seulement `level` OU `xp`, pas les deux.",
      ephemeral: true,
    });
    return null;
  }

  return level !== null
    ? { mode: "level", value: level }
    : { mode: "xp", value: xp as number };
}

async function setXpCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const target = interaction.options.getUser("member", true);
  const input = await resolveLevelOrXpOption(interaction);
  if (!input) return;
  const reason = interaction.options.getString("reason") ?? "Aucune raison fournie.";

  const currentXp = await getUserXp(guild.id, target.id);
  const previousLevel = calculateLevel(currentXp).level;
  const newXp = input.mode === "level" ? xpForLevel(input.value) : input.value;

  await setUserXp(guild.id, target.id, newXp);

  const newLevel = calculateLevel(newXp).level;

  if (newLevel !== previousLevel) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member) {
      await grantLevelUpRewards(guild, member, previousLevel, newLevel);
    }
  }

  await interaction.reply({
    content: `XP de **${target.tag}** défini à **${newXp}** (niveau ${newLevel}). Raison : ${reason}`,
  });
}

async function addXpCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const target = interaction.options.getUser("member", true);
  const input = await resolveLevelOrXpOption(interaction);
  if (!input) return;
  const reason = interaction.options.getString("reason") ?? "Aucune raison fournie.";

  const currentXp = await getUserXp(guild.id, target.id);
  const previousLevel = calculateLevel(currentXp).level;

  const newXp =
    input.mode === "level"
      ? xpForLevel(previousLevel + input.value)
      : currentXp + input.value;

  await setUserXp(guild.id, target.id, newXp);

  const newLevel = calculateLevel(newXp).level;

  if (newLevel !== previousLevel) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member) {
      await grantLevelUpRewards(guild, member, previousLevel, newLevel);
    }
  }

  await interaction.reply({
    content: `**${input.value}** ${input.mode === "level" ? "niveau(x)" : "XP"} ajouté(s) à **${target.tag}** (XP total : ${newXp}, niveau ${newLevel}). Raison : ${reason}`,
  });
}

async function removeXpCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Cette commande doit être utilisée dans un serveur.",
    });
    return;
  }

  const target = interaction.options.getUser("member", true);
  const input = await resolveLevelOrXpOption(interaction);
  if (!input) return;
  const reason = interaction.options.getString("reason") ?? "Aucune raison fournie.";

  const currentXp = await getUserXp(guild.id, target.id);
  const previousLevel = calculateLevel(currentXp).level;

  const newXp = Math.max(
    0,
    input.mode === "level"
      ? xpForLevel(Math.max(0, previousLevel - input.value))
      : currentXp - input.value,
  );

  await setUserXp(guild.id, target.id, newXp);

  const newLevel = calculateLevel(newXp).level;
  if (newLevel !== previousLevel) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member) {
      await grantLevelUpRewards(guild, member, previousLevel, newLevel);
    }
  }

  await interaction.reply({
    content: `**${input.value}** ${input.mode === "level" ? "niveau(x)" : "XP"} retiré(s) à **${target.tag}** (XP total : ${newXp}, niveau ${newLevel}). Raison : ${reason}`,
  });
}

// Préfixe des commandes texte. Les seules commandes qui restent Slash sont
// /owner et /say ; toutes les autres sont routées par ce système.
const PREFIX_COMMAND_PREFIX = "*";

class PrefixCommandOptions {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly subcommandName: string | null,
  ) {}

  getSubcommand(required = true): string | null {
    if (required && !this.subcommandName) {
      throw new Error("Une sous-commande est requise.");
    }
    return this.subcommandName;
  }

  getString(name: string, required = false): string | null {
    const value = this.values.get(name);
    if (value === undefined || value === null) {
      if (required) {
        throw new Error(`L'option \`${name}\` est requise.`);
      }
      return null;
    }
    return String(value);
  }

  getInteger(name: string, required = false): number | null {
    const value = this.values.get(name);
    if (value === undefined || value === null) {
      if (required) {
        throw new Error(`L'option \`${name}\` est requise.`);
      }
      return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error(`L'option \`${name}\` doit être un nombre entier.`);
    }
    return parsed;
  }

  getBoolean(name: string, required = false): boolean | null {
    const value = this.values.get(name);
    if (value === undefined || value === null) {
      if (required) {
        throw new Error(`L'option \`${name}\` est requise.`);
      }
      return null;
    }
    return Boolean(value);
  }

  getUser(name: string, required = false): User | null {
    const value = this.values.get(name);
    if (!value) {
      if (required) {
        throw new Error(`L'option \`${name}\` est requise.`);
      }
      return null;
    }
    return value as User;
  }

  getRole(name: string, required = false): any {
    const value = this.values.get(name);
    if (!value && required) {
      throw new Error(`L'option \`${name}\` est requise.`);
    }
    return value ?? null;
  }

  getChannel(name: string, required = false): any {
    const value = this.values.get(name);
    if (!value && required) {
      throw new Error(`L'option \`${name}\` est requise.`);
    }
    return value ?? null;
  }
}

class PrefixCommandInteraction {
  readonly commandName: string;
  readonly options: PrefixCommandOptions;
  readonly client: DiscordClient<boolean>;
  readonly guild: Guild;
  readonly user: User;
  readonly member: GuildMember | null;
  readonly memberPermissions: PermissionsBitField | null;
  readonly channel: Message["channel"];
  readonly channelId: string;
  readonly createdTimestamp: number;
  private responseMessage: Message | null = null;
  private hasReplied = false;
  private hasDeferred = false;

  constructor(
    private readonly sourceMessage: Message,
    client: DiscordClient<boolean>,
    commandName: string,
    options: PrefixCommandOptions,
  ) {
    if (!sourceMessage.guild) {
      throw new Error("Cette commande doit être utilisée dans un serveur.");
    }
    this.commandName = commandName;
    this.options = options;
    this.client = client;
    this.guild = sourceMessage.guild;
    this.user = sourceMessage.author;
    this.member = sourceMessage.member;
    this.memberPermissions = sourceMessage.member?.permissions ?? null;
    this.channel = sourceMessage.channel;
    this.channelId = sourceMessage.channelId;
    this.createdTimestamp = sourceMessage.createdTimestamp;
  }

  get replied() {
    return this.hasReplied;
  }

  get deferred() {
    return this.hasDeferred;
  }

  async reply(payload: any) {
    const normalized = normalizePrefixReply(payload);
    if (this.hasDeferred) {
      return this.editReply(normalized);
    }
    this.responseMessage = await this.sourceMessage.reply(normalized);
    this.hasReplied = true;
    return this.responseMessage;
  }

  async deferReply() {
    this.hasDeferred = true;
    return this;
  }

  async editReply(payload: any) {
    const normalized = normalizePrefixReply(payload);
    if (this.responseMessage) {
      return this.responseMessage.edit(normalized);
    }
    this.responseMessage = await this.sourceMessage.reply(normalized);
    this.hasReplied = true;
    return this.responseMessage;
  }

  async followUp(payload: any) {
    return this.sourceMessage.reply(normalizePrefixReply(payload));
  }

  async fetchReply() {
    return this.responseMessage ?? this.sourceMessage;
  }

  async fetchReferencedMessage(): Promise<Message | null> {
    if (!this.sourceMessage.reference?.messageId) {
      return null;
    }

    return this.sourceMessage.fetchReference().catch(() => null);
  }

  async showModal() {
    throw new Error("Les modales ne peuvent pas être ouvertes depuis une commande préfixée.");
  }

  async deleteSourceMessage() {
    await this.sourceMessage.delete().catch((err) => {
      logger.warn(
        { err, command: this.commandName, messageId: this.sourceMessage.id },
        "Failed to delete prefix command message",
      );
    });
  }
}

async function deletePrefixSourceMessage(
  interaction: ChatInputCommandInteraction,
) {
  if (
    interaction instanceof PrefixCommandInteraction &&
    shouldDeletePrefixCommand(interaction.commandName)
  ) {
    await interaction.deleteSourceMessage();
  }
}

function normalizePrefixReply(payload: any): any {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const { ephemeral: _ephemeral, ...messagePayload } = payload;
  return messagePayload;
}

async function resolvePrefixOptionValue(
  guild: Guild,
  option: any,
  token: string,
): Promise<unknown> {
  if (option.type === 3) {
    return token;
  }
  if (option.type === 4) {
    const value = Number(token);
    if (!Number.isInteger(value)) {
      throw new Error(`\`${token}\` doit être un nombre entier.`);
    }
    return value;
  }
  if (option.type === 5) {
    const normalized = token.toLowerCase();
    if (["true", "vrai", "oui", "on", "1"].includes(normalized)) return true;
    if (["false", "faux", "non", "off", "0"].includes(normalized)) return false;
    throw new Error(`\`${token}\` doit être vrai ou faux.`);
  }
  if (option.type === 6) {
    const id = extractDiscordId(token);
    const user = id
      ? await guild.client.users.fetch(id).catch(() => null)
      : null;
    if (!user) throw new Error(`Membre introuvable : ${token}`);
    return user;
  }
  // Discord option types: 7 = channel, 8 = role.
  if (option.type === 8) {
    const id = extractDiscordId(token);
    const role = id ? await guild.roles.fetch(id).catch(() => null) : null;
    if (!role) throw new Error(`Rôle introuvable : ${token}`);
    return role;
  }
  if (option.type === 7) {
    const id = extractDiscordId(token);
    const channel = id
      ? await guild.channels.fetch(id).catch(() => null)
      : null;
    if (!channel) throw new Error(`Salon introuvable : ${token}`);
    return channel;
  }
  return token;
}

async function buildPrefixCommandInteraction(
  client: DiscordClient<boolean>,
  message: Message,
  commandName: string,
  tokens: string[],
): Promise<PrefixCommandInteraction> {
  const definitions = enabledCommands;
  const definition = definitions.find((command) => command.name === commandName);
  if (!definition) {
    throw new Error(`Commande inconnue : \`${commandName}\`.`);
  }

  const definitionOptions: any[] = definition.options ?? [];
  let subcommandName: string | null = null;
  let optionDefinitions = definitionOptions;
  let tokenIndex = 0;
  const referencedMessage =
    commandName === "ban" && message.reference?.messageId
      ? await message.fetchReference().catch(() => null)
      : null;
  const isReplyBanWithoutExplicitUser =
    Boolean(referencedMessage) &&
    (!tokens[0] ||
      !tokens[0].startsWith("<@") && !extractDiscordId(tokens[0]));

  if (isReplyBanWithoutExplicitUser && referencedMessage) {
    optionDefinitions = definitionOptions.filter(
      (option: any) => option.name !== "user",
    );
  }

  const selectedSubcommand = definitionOptions.find(
    (option: any) =>
      (option.type === 1 || option.type === 2) &&
      option.name === tokens[0]?.toLowerCase(),
  );

  if (selectedSubcommand?.type === 2) {
    const nestedSubcommand = (selectedSubcommand.options ?? []).find(
      (option: any) =>
        option.type === 1 && option.name === tokens[1]?.toLowerCase(),
    );

    if (!nestedSubcommand) {
      throw new Error(
        `Sous-commande invalide pour \`*${commandName} ${selectedSubcommand.name}\`.`,
      );
    }

    subcommandName = nestedSubcommand.name;
    optionDefinitions = nestedSubcommand.options ?? [];
    tokenIndex = 2;
  } else if (selectedSubcommand) {
    subcommandName = selectedSubcommand.name;
    optionDefinitions = selectedSubcommand.options ?? [];
    tokenIndex = 1;
  } else if (
    definitionOptions.some((option: any) => option.type === 1 || option.type === 2) &&
    !(commandName === "help" && tokens.length === 0)
  ) {
    throw new Error(
      `Sous-commande invalide pour \`*${commandName}\`.`,
    );
  }

  const values = new Map<string, unknown>();
  if (isReplyBanWithoutExplicitUser && referencedMessage) {
    values.set("user", referencedMessage.author);
  }
  const isSanctionsUserShorthand =
    commandName === "sanctions" &&
    tokenIndex < tokens.length &&
    tokens.length - tokenIndex === 1 &&
    Boolean(extractDiscordId(tokens[tokenIndex] ?? ""));

  if (isSanctionsUserShorthand) {
    const userOption = optionDefinitions.find((option: any) => option.name === "user");
    if (userOption) {
      values.set(
        "user",
        await resolvePrefixOptionValue(
          message.guild!,
          userOption,
          tokens[tokenIndex]!,
        ),
      );
      tokenIndex = tokens.length;
    }
  }

  for (let index = 0; index < optionDefinitions.length; index += 1) {
    if (isSanctionsUserShorthand) {
      break;
    }
    const option = optionDefinitions[index]!;
    const remaining = tokens.length - tokenIndex;
    if (remaining <= 0) {
      if (option.required) {
        throw new Error(`L'option \`${option.name}\` est requise.`);
      }
      continue;
    }

    const isLastString =
      option.type === 3 && index === optionDefinitions.length - 1;
    const rawValue = isLastString
      ? tokens.slice(tokenIndex).join(" ")
      : tokens[tokenIndex];
    tokenIndex = isLastString ? tokens.length : tokenIndex + 1;
    values.set(
      option.name,
      await resolvePrefixOptionValue(message.guild!, option, rawValue!),
    );
  }

  if (tokenIndex < tokens.length) {
    throw new Error("Trop d'arguments. Utilise des guillemets pour les textes contenant des espaces.");
  }

  return new PrefixCommandInteraction(
    message,
    client,
    commandName,
    new PrefixCommandOptions(values, subcommandName),
  );
}

function registerPrefixCommands(client: DiscordClient<boolean>) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    if (!message.content.startsWith(PREFIX_COMMAND_PREFIX)) {
      return;
    }

    const tokens = tokenizePrefixCommand(
      message.content.slice(PREFIX_COMMAND_PREFIX.length).trim(),
    );
    const requestedName = tokens.shift()?.toLowerCase();
    if (!requestedName) return;

    const commandName =
      requestedName === "serveur" ? "server" : requestedName;

    if (commandName === "ping") {
      if (
        message.author.id !== BOT_OWNER_ID &&
        (await isBotMaintenanceEnabled())
      ) {
        await message
          .reply(
            "🛠️ Le bot est actuellement en maintenance. Seul le propriétaire principal peut utiliser ses commandes.",
          )
          .catch((err) => {
            logger.error({ err }, "Failed to reply to maintenance *ping");
          });
        return;
      }

      const sentAt = Date.now();
      const reply = await message.reply("🏓 Pong !").catch((err) => {
        logger.error({ err }, "Failed to reply to *ping");
        return null;
      });

      if (reply) {
        await reply
          .edit(
            `🏓 Pong ! Le bot est bien connecté. (latence : ${
              Date.now() - sentAt
            }ms, API : ${Math.round(client.ws.ping)}ms)`,
          )
          .catch((err) => {
            logger.error({ err }, "Failed to edit *ping reply");
          });
      }
      if (shouldDeletePrefixCommand(commandName)) {
        await message.delete().catch((err) => {
          logger.warn(
            { err, command: commandName, messageId: message.id },
            "Failed to delete prefix command message",
          );
        });
      }
      return;
    }

    if (commandName === "owner" || commandName === "say") {
      await message.reply(
        `\`*${commandName}\` est disponible uniquement avec la commande Slash \`/${commandName}\`.`,
      );
      return;
    }

    try {
      const interaction = await buildPrefixCommandInteraction(
        client,
        message,
        commandName,
        tokens,
      );
      await executeCommandWithGuards(
        interaction as unknown as ChatInputCommandInteraction,
      );
    } catch (err) {
      const content =
        err instanceof Error ? err.message : "Commande préfixée invalide.";
      await message.reply(`❌ ${content}`).catch((replyError) => {
        logger.error({ err: replyError }, "Failed to reply to prefix command");
      });
    }
  });
}

function registerAutoReactChannel(client: DiscordClient<boolean>) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    const settings = await getGuildSettings(message.guild.id);
    const autoReactChannelId = settings.channelIds.autoReact;
    if (!autoReactChannelId || message.channelId !== autoReactChannelId) {
      return;
    }

    const emojiName = settings.autoReactEmojiName;
    const emoji = message.guild.emojis.cache.find(
      (candidate) =>
        candidate.name?.toLowerCase() === emojiName.toLowerCase(),
    );

    if (!emoji) {
      logger.warn(
        { emojiName, guildId: message.guild.id },
        "Auto-react emoji introuvable dans le cache des emojis du serveur",
      );
      return;
    }

    await message.react(emoji).catch((err) => {
      logger.error(
        { err, messageId: message.id },
        "Failed to auto-react to message",
      );
    });
  });
}

function registerMentionResponder(client: DiscordClient<boolean>) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild || !client.user) {
      return;
    }

    if (!message.mentions.has(client.user.id)) {
      return;
    }

    await message
      .reply({
        content: BOT_MENTION_MESSAGE,
        allowedMentions: { repliedUser: false },
      })
      .catch((err) => {
        logger.error({ err }, "Failed to reply to bot mention");
      });
  });
}

function registerVoiceHub(client: DiscordClient<boolean>) {
  client.on("voiceStateUpdate", async (oldState, newState) => {
    try {
      const settings = await getGuildSettings(newState.guild.id);
      if (
        newState.channelId &&
        newState.channelId === settings.channelIds.voiceHub &&
        oldState.channelId !== newState.channelId
      ) {
        await createTempVoiceChannel(newState);
      }

      if (
        oldState.channelId &&
        oldState.channelId !== newState.channelId &&
        TEMP_VOICE_CHANNEL_IDS.has(oldState.channelId)
      ) {
        await deleteTempVoiceChannelIfEmpty(oldState);
      }
    } catch (err) {
      logger.error({ err }, "Voice hub handling failed");
    }
  });

  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (
      newChannel.isDMBased() ||
      newChannel.type !== ChannelType.GuildVoice ||
      !TEMP_VOICE_CHANNEL_IDS.has(newChannel.id) ||
      oldChannel.isDMBased()
    ) {
      return;
    }

    await logTempVoiceChannelUpdate(
      oldChannel as VoiceBasedChannel,
      newChannel,
    ).catch((err) => {
      logger.error(
        { err, channelId: newChannel.id },
        "Failed to log temp voice channel update",
      );
    });
  });
}

function permissionListDiff(oldBits: bigint, newBits: bigint) {
  const oldSet = new PermissionsBitField(oldBits).toArray();
  const newSet = new PermissionsBitField(newBits).toArray();
  return {
    added: newSet.filter((permission) => !oldSet.includes(permission)),
    removed: oldSet.filter((permission) => !newSet.includes(permission)),
  };
}

// Décrit les changements de permissions (overwrites) entre deux versions
// d'un salon vocal temporaire, pour le log en temps réel.
function diffTempVoicePermissionOverwrites(
  oldChannel: VoiceBasedChannel,
  newChannel: VoiceBasedChannel,
): string[] {
  const lines: string[] = [];
  const ids = new Set([
    ...oldChannel.permissionOverwrites.cache.keys(),
    ...newChannel.permissionOverwrites.cache.keys(),
  ]);

  for (const id of ids) {
    const oldOverwrite = oldChannel.permissionOverwrites.cache.get(id);
    const newOverwrite = newChannel.permissionOverwrites.cache.get(id);
    const oldAllow = oldOverwrite?.allow.bitfield ?? 0n;
    const oldDeny = oldOverwrite?.deny.bitfield ?? 0n;
    const newAllow = newOverwrite?.allow.bitfield ?? 0n;
    const newDeny = newOverwrite?.deny.bitfield ?? 0n;

    if (oldAllow === newAllow && oldDeny === newDeny) {
      continue;
    }

    const type = newOverwrite?.type ?? oldOverwrite?.type;
    const mention = type === OverwriteType.Role ? `<@&${id}>` : `<@${id}>`;

    const allowDiff = permissionListDiff(oldAllow, newAllow);
    const denyDiff = permissionListDiff(oldDeny, newDeny);

    const parts: string[] = [];
    if (allowDiff.added.length > 0) {
      parts.push(`autorisé : ${allowDiff.added.join(", ")}`);
    }
    if (allowDiff.removed.length > 0) {
      parts.push(`plus autorisé : ${allowDiff.removed.join(", ")}`);
    }
    if (denyDiff.added.length > 0) {
      parts.push(`refusé : ${denyDiff.added.join(", ")}`);
    }
    if (denyDiff.removed.length > 0) {
      parts.push(`plus refusé : ${denyDiff.removed.join(", ")}`);
    }

    if (parts.length > 0) {
      lines.push(`${mention} (\`${id}\`) — ${parts.join(" · ")}`);
    }
  }

  return lines;
}

async function logTempVoiceChannelUpdate(
  oldChannel: VoiceBasedChannel,
  newChannel: VoiceBasedChannel,
) {
  const changes: string[] = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`**Nom** : \`${oldChannel.name}\` → \`${newChannel.name}\``);
  }

  if (oldChannel.userLimit !== newChannel.userLimit) {
    changes.push(
      `**Limite de membres** : \`${oldChannel.userLimit || "aucune"}\` → \`${newChannel.userLimit || "aucune"}\``,
    );
  }

  if (oldChannel.bitrate !== newChannel.bitrate) {
    changes.push(
      `**Bitrate** : \`${Math.round(oldChannel.bitrate / 1000)} kbps\` → \`${Math.round(newChannel.bitrate / 1000)} kbps\``,
    );
  }

  changes.push(...diffTempVoicePermissionOverwrites(oldChannel, newChannel));

  if (changes.length === 0) {
    return;
  }

  await logToGuild(
    newChannel.guild,
    new EmbedBuilder()
      .setTitle("🔧 Salon vocal temporaire modifié")
      .setColor(0xf1c40f)
      .addFields(
        {
          name: "Salon",
          value: `${newChannel.name}\n\`${newChannel.id}\``,
        },
        {
          name: "Modifications",
          value: changes.join("\n").slice(0, 1024),
        },
      )
      .setTimestamp(),
    "tempVoice",
  );
}

async function createTempVoiceChannel(newState: VoiceState) {
  const guild = newState.guild;
  const member = newState.member;
  const hubChannel = newState.channel;

  if (!member || !hubChannel) {
    return;
  }
  const settings = await getGuildSettings(guild.id);
  const lockTargetRoleIds = getGuildLockTargetRoleIds(settings);

  const botMember = guild.members.me;
  if (
    !botMember?.permissions.has(PermissionFlagsBits.ManageChannels) ||
    !botMember.permissions.has(PermissionFlagsBits.MoveMembers)
  ) {
    logger.error(
      { guildId: guild.id },
      "Missing permissions to create temp voice channels (ManageChannels / MoveMembers)",
    );
    return;
  }

  const channelName = `🔒 ${member.displayName}`.slice(0, 100);

  const tempChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: hubChannel.parentId,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      ...lockTargetRoleIds.map((roleId) => ({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.Connect],
      })),
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.Stream,
          PermissionFlagsBits.UseVAD,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
    reason: `Salon vocal temporaire pour ${member.user.tag}`,
  });

  TEMP_VOICE_CHANNEL_IDS.add(tempChannel.id);

  await member.voice.setChannel(tempChannel).catch((err) => {
    logger.error(
      { err, memberId: member.id, channelId: tempChannel.id },
      "Failed to move member into their temp voice channel",
    );
  });

  await tempChannel
    .send({
      content: [
        `${member} voici ton salon vocal !`,
        "Tu peux le personnaliser et en gérer les accès :",
        "- **Modifier le salon** (nom, limite de membres, bitrate...) via le menu du salon.",
        "- **Permissions** : ajoute un membre ou un rôle en accès autorisé pour que tes amis puissent rejoindre, ou retire l'accès à quelqu'un.",
        "Le salon sera automatiquement supprimé dès qu'il sera vide.",
      ].join("\n"),
      allowedMentions: { users: [member.id] },
    })
    .catch((err) => {
      logger.error(
        { err, channelId: tempChannel.id },
        "Failed to send welcome message in temp voice channel",
      );
    });

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("Salon vocal temporaire créé")
      .setColor(0x2ecc71)
      .addFields(
        {
          name: "Membre",
          value: `${member.user.tag}\n\`${member.id}\``,
          inline: true,
        },
        {
          name: "Salon",
          value: `${tempChannel.name}\n\`${tempChannel.id}\``,
          inline: true,
        },
      )
      .setTimestamp(),
    "tempVoice",
  );
}

async function deleteTempVoiceChannelIfEmpty(oldState: VoiceState) {
  const channelId = oldState.channelId;
  if (!channelId) {
    return;
  }

  const channel = await oldState.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildVoice) {
    TEMP_VOICE_CHANNEL_IDS.delete(channelId);
    return;
  }

  if (channel.members.size > 0) {
    return;
  }

  const guild = channel.guild;
  const channelName = channel.name;

  await channel.delete("Aucun membre").catch((err) => {
    logger.error(
      { err, channelId },
      "Failed to delete empty temp voice channel",
    );
  });

  TEMP_VOICE_CHANNEL_IDS.delete(channelId);

  await logToGuild(
    guild,
    new EmbedBuilder()
      .setTitle("Salon vocal temporaire supprimé")
      .setColor(0xe74c3c)
      .addFields(
        {
          name: "Salon",
          value: `${channelName}\n\`${channelId}\``,
          inline: true,
        },
        { name: "Raison", value: "Aucun membre" },
      )
      .setTimestamp(),
    "tempVoice",
  );
}

function registerSecurityAndOnboarding(client: DiscordClient<boolean>) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) {
      return;
    }

    const guild = message.guild;
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await touchMemberProfile(member).catch((err) =>
        logger.warn({ err, guildId: guild.id, userId: member.id }, "Failed to touch member profile"),
      );
    }

    await advanceTriggeredMissions(guild, message.author.id, "message").catch((err) =>
      logger.error({ err, guildId: guild.id }, "Failed to advance message missions"),
    );

    const config = await getSecurityConfig(guild.id).catch(() => null);
    if (!config?.antiSpamEnabled) {
      return;
    }

    const now = Date.now();
    const key = `${guild.id}:${message.author.id}`;
    const timestamps = trimWindow(
      SECURITY_MESSAGE_WINDOWS.get(key) ?? [],
      now,
      SPAM_WINDOW_MS,
    );
    timestamps.push(now);
    SECURITY_MESSAGE_WINDOWS.set(key, timestamps);

    const spamThreshold = Math.min(
      MAX_SPAM_THRESHOLD,
      Math.max(MIN_SPAM_THRESHOLD, config.spamThreshold ?? MIN_SPAM_THRESHOLD),
    );
    const burst = isBurst(timestamps, now, SPAM_WINDOW_MS, spamThreshold);
    if (!burst || !member) {
      return;
    }

    if (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      isProtectedSecurityTarget(guild, member)
    ) {
      return;
    }

    const detectionCount = await recordSecurityDetection(
      guild,
      member,
      "anti-spam",
    );
    if (detectionCount !== null) {
      const escalation = await applySecurityEscalation(
        guild,
        member,
        "anti-spam",
        detectionCount,
      );
      if (escalation) {
        await sendSecurityAlert(
          guild,
          "Escalade anti-spam",
          `${member} a atteint ${detectionCount} détections anti-spam et a été banni${
            escalation.durationMinutes === null ? " définitivement" : " pendant 24 heures"
          }.`,
          {
            Membre: `${member.user.tag} (${member.id})`,
            Détections: String(detectionCount),
            "ID sanction": escalation.sanctionId
              ? `\`${escalation.sanctionId}\``
              : "inconnu",
          },
        );
        SECURITY_MESSAGE_WINDOWS.delete(key);
        return;
      }
    }

    const reason = `Anti-spam : ${timestamps.length} messages en moins de ${SPAM_WINDOW_MS / 1000} secondes`;
    const result = await applyAutomatedTimeout(
      guild,
      member,
      reason,
      config.spamTimeoutMinutes ?? SPAM_TIMEOUT_MINUTES,
    );
    if (!result) {
      return;
    }
    await sendSecurityAlert(
      guild,
      "Anti-spam déclenché",
      `${member} a envoyé ${timestamps.length} messages en moins de ${SPAM_WINDOW_MS / 1000} secondes.`,
      {
        Membre: `${member.user.tag} (${member.id})`,
        Salon: `<#${message.channel.id}>`,
        Action: `Timeout ${config.spamTimeoutMinutes ?? SPAM_TIMEOUT_MINUTES} minutes`,
        "ID sanction": result.sanctionId ? `\`${result.sanctionId}\`` : "inconnu",
      },
    );
    SECURITY_MESSAGE_WINDOWS.delete(key);
  });

  client.on("guildMemberAdd", async (member) => {
    const guild = member.guild;
    const now = Date.now();
    const joins = trimWindow(
      SECURITY_JOIN_WINDOWS.get(guild.id) ?? [],
      now,
      RAID_JOIN_WINDOW_MS,
    );
    joins.push(now);
    SECURITY_JOIN_WINDOWS.set(guild.id, joins);
    const recentJoinMembers = (SECURITY_JOIN_MEMBERS.get(guild.id) ?? []).filter(
      (entry) => now - entry.timestamp < RAID_JOIN_WINDOW_MS,
    );
    recentJoinMembers.push({ userId: member.id, timestamp: now });
    SECURITY_JOIN_MEMBERS.set(guild.id, recentJoinMembers);

    await touchMemberProfile(member, { joined: true }).catch((err) =>
      logger.warn(
        { err, guildId: guild.id, userId: member.id },
        "Failed to create member profile",
      ),
    );
    await advanceTriggeredMissions(guild, member.id, "join").catch((err) =>
      logger.error({ err, guildId: guild.id }, "Failed to advance join missions"),
    );

    const guildSettings = await getGuildSettings(guild.id);
    const onboardingRoleId = guildSettings.roleIds.onboarding;
    if (onboardingRoleId) {
      await member.roles
        .add(onboardingRoleId, "Onboarding automatique")
        .catch((err) =>
          logger.warn(
            { err, guildId: guild.id, userId: member.id },
            "Failed to grant onboarding role",
          ),
        );
    }

    const welcomeChannelId = guildSettings.channelIds.welcome;
    const welcomeChannel = welcomeChannelId
      ? await guild.channels.fetch(welcomeChannelId).catch(() => null)
      : null;
    if (welcomeChannel && "send" in welcomeChannel) {
      await welcomeChannel
        .send({
          content: guildSettings.welcomeMessage.replaceAll("{member}", `${member}`).replaceAll(
            "{server}",
            guild.name,
          ),
          allowedMentions: { users: [member.id] },
        })
        .catch((err) => logger.warn({ err }, "Failed to send onboarding welcome"));
    }

    const config = await getSecurityConfig(guild.id).catch(() => null);
    if (
      config?.antiRaidEnabled &&
      isBurst(joins, now, RAID_JOIN_WINDOW_MS, RAID_JOIN_THRESHOLD)
    ) {
      const lastBurst = SECURITY_RAID_BURST_HANDLED_AT.get(guild.id) ?? 0;
      const isNewBurst =
        now - lastBurst >= RAID_JOIN_WINDOW_MS;
      if (isNewBurst) {
        SECURITY_RAID_BURST_HANDLED_AT.set(guild.id, now);
        const uniqueUserIds = [
          ...new Set(recentJoinMembers.map((entry) => entry.userId)),
        ];
        for (const userId of uniqueUserIds) {
          const joinedMember = await guild.members.fetch(userId).catch(() => null);
          if (!joinedMember) {
            continue;
          }
          const detectionCount = await recordSecurityDetection(
            guild,
            joinedMember,
            "anti-raid",
          );
          if (detectionCount !== null) {
            const escalation = await applySecurityEscalation(
              guild,
              joinedMember,
              "anti-raid",
              detectionCount,
            );
            if (escalation) {
              await sendSecurityAlert(
                guild,
                "Escalade anti-raid",
                `${joinedMember} a atteint ${detectionCount} détections anti-raid et a été banni${
                  escalation.durationMinutes === null
                    ? " définitivement"
                    : " pendant 24 heures"
                }.`,
                {
                  Membre: `${joinedMember.user.tag} (${joinedMember.id})`,
                  Détections: String(detectionCount),
                  "ID sanction": escalation.sanctionId
                    ? `\`${escalation.sanctionId}\``
                    : "inconnu",
                },
              );
            }
          }
        }
      }
      await applySecurityLockdown(guild, true).catch((err) =>
        logger.error({ err, guildId: guild.id }, "Failed to activate raid lockdown"),
      );
      await sendSecurityAlert(
        guild,
        "Anti-raid déclenché",
        `${joins.length} arrivées ont été détectées en moins d’une minute.`,
        { "Dernière arrivée": `${member.user.tag} (${member.id})` },
      );
    }
  });
}

function registerAntiNuke(client: DiscordClient<boolean>) {
  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    const config = await getSecurityConfig(guild.id).catch((err) => {
      logger.warn({ err, guildId: guild.id }, "Failed to load anti-nuke config");
      return null;
    });
    if (!config?.antiNukeEnabled || !ANTI_NUKE_ACTIONS.has(entry.action)) {
      return;
    }

    const executorId = entry.executorId;
    if (!executorId || executorId === client.user?.id || executorId === guild.ownerId) {
      return;
    }

    const executor = await guild.members.fetch(executorId).catch(() => null);
    if (!executor || isProtectedSecurityTarget(guild, executor)) {
      return;
    }

    const now = Date.now();
    const key = `${guild.id}:${executorId}`;
    const timestamps = trimWindow(
      SECURITY_NUKE_WINDOWS.get(key) ?? [],
      now,
      ANTI_NUKE_WINDOW_MS,
    );
    timestamps.push(now);
    SECURITY_NUKE_WINDOWS.set(key, timestamps);

    const threshold = DEFAULT_ANTI_NUKE_THRESHOLD;
    if (!isBurst(timestamps, now, ANTI_NUKE_WINDOW_MS, threshold)) {
      return;
    }

    const actionLabel = String(entry.action);
    const reason = `Anti-nuke : ${timestamps.length} actions destructrices en moins de ${ANTI_NUKE_WINDOW_MS / 1000} secondes (${actionLabel})`;
    const result = await applyAutomatedBan(guild, executor, reason);
    if (!result) {
      return;
    }

    await applySecurityLockdown(guild, true).catch((err) =>
      logger.error({ err, guildId: guild.id }, "Failed to activate anti-nuke lockdown"),
    );
    await sendSecurityAlert(
      guild,
      "Anti-nuke déclenché",
      `${executor} a effectué plusieurs actions destructrices rapidement et a été banni.`,
      {
        Exécuteur: `${executor.user.tag} (${executor.id})`,
        Action: actionLabel,
        "Nombre d’actions": `${timestamps.length}`,
        "ID sanction": result.sanctionId ? `\`${result.sanctionId}\`` : "inconnu",
      },
    );
    SECURITY_NUKE_WINDOWS.delete(key);
  });
}

function registerGuildLogs(client: DiscordClient<boolean>) {
  client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (!newMessage.guild) {
      return;
    }

    const previousMessage = oldMessage.partial
      ? await oldMessage.fetch().catch(() => oldMessage)
      : oldMessage;
    const currentMessage = newMessage.partial
      ? await newMessage.fetch().catch(() => newMessage)
      : newMessage;

    if (currentMessage.author?.bot) {
      return;
    }

    const previousAttachments = Array.from(previousMessage.attachments.values());
    const currentAttachments = Array.from(currentMessage.attachments.values());
    const attachmentSignature = (
      attachments: typeof currentAttachments,
    ) =>
      attachments
        .map(
          (attachment) =>
            `${attachment.id}:${attachment.name ?? ""}:${attachment.url}`,
        )
        .sort()
        .join("|");
    const attachmentsChanged =
      oldMessage.partial ||
      newMessage.partial ||
      attachmentSignature(previousAttachments) !==
        attachmentSignature(currentAttachments);

    if (
      !shouldLogMessageUpdate(
        previousMessage.content,
        currentMessage.content,
        oldMessage.partial || newMessage.partial,
      ) &&
      !attachmentsChanged
    ) {
      return;
    }

    const previousAttachmentText =
      previousAttachments.length > 0
        ? previousAttachments
            .map(
              (attachment) =>
                `[${attachment.name ?? "Pièce jointe"}](${attachment.url})`,
            )
            .join("\n")
        : oldMessage.partial
          ? "Anciennes pièces jointes indisponibles (message partiel)."
          : "Aucune";
    const currentAttachmentText =
      currentAttachments.length > 0
        ? currentAttachments
            .map(
              (attachment) =>
                `[${attachment.name ?? "Pièce jointe"}](${attachment.url})`,
            )
            .join("\n")
        : "Aucune";

    await logToGuild(
      newMessage.guild,
      new EmbedBuilder()
        .setTitle("Message modifié")
        .setColor(0xf1c40f)
        .addFields(
          {
            name: "Auteur",
            value: `${currentMessage.author?.tag ?? "Inconnu"}\n\`${currentMessage.author?.id ?? "inconnu"}\``,
            inline: true,
          },
          { name: "Salon", value: `<#${currentMessage.channel.id}>`, inline: true },
          {
            name: "Message",
            value: `\`${currentMessage.id}\``,
            inline: true,
          },
          {
            name: "Avant",
            value: formatMessageContent(previousMessage.content),
          },
          {
            name: "Après",
            value: formatMessageContent(currentMessage.content),
          },
          ...(attachmentsChanged
            ? [
                {
                  name: "Pièces jointes avant",
                  value: previousAttachmentText.slice(0, 1024),
                },
                {
                  name: "Pièces jointes après",
                  value: currentAttachmentText.slice(0, 1024),
                },
              ]
            : []),
        )
        .setTimestamp(),
      "messages",
    );
  });

  client.on("messageDelete", async (message) => {
    if (!message.guild) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    const attachments = Array.from(message.attachments.values()).map(
      (attachment) => ({
        url: attachment.url,
        contentType: attachment.contentType,
        name: attachment.name,
      }),
    );
    const imageUrls = getImageAttachmentUrls(attachments);
    const imageLinks = imageUrls
      .map((url, index) => `[Image ${index + 1}](${url})`)
      .join("\n");
    const nonImageAttachmentLinks = attachments
      .filter((attachment) => !imageUrls.includes(attachment.url))
      .map(
        (attachment) =>
          `[${attachment.name ?? "Pièce jointe"}](${attachment.url})`,
      )
      .join("\n");

    const deletedMessageEmbeds = [
      new EmbedBuilder()
        .setTitle("Message supprimé")
        .setColor(0xe74c3c)
        .addFields(
          {
            name: "Auteur",
            value: `${message.author?.tag ?? "Inconnu"}\n\`${message.author?.id ?? "inconnu"}\``,
            inline: true,
          },
          { name: "Salon", value: `<#${message.channel.id}>`, inline: true },
          { name: "Message", value: `\`${message.id}\``, inline: true },
          {
            name: "Contenu",
            value: formatMessageContent(message.content),
          },
          ...(imageLinks
            ? [{ name: "Images", value: imageLinks.slice(0, 1024) }]
            : []),
          ...(nonImageAttachmentLinks
            ? [
                {
                  name: "Autres pièces jointes",
                  value: nonImageAttachmentLinks.slice(0, 1024),
                },
              ]
            : []),
        )
        .setTimestamp(),
    ];

    if (imageUrls[0]) {
      deletedMessageEmbeds[0]!.setImage(imageUrls[0]);
      for (const imageUrl of imageUrls.slice(1, 10)) {
        deletedMessageEmbeds.push(
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setImage(imageUrl),
        );
      }
    }

    await logToGuild(message.guild, deletedMessageEmbeds, "messages");
  });

  client.on("guildMemberAdd", async (member) => {
    try {
      await logToGuild(
        member.guild,
        new EmbedBuilder()
          .setTitle("Arrivée d’un membre")
          .setColor(0x2ecc71)
          .addFields({
            name: "Membre",
            value: `${member.user?.tag ?? "Inconnu"}\n\`${member.id}\``,
          })
          .setTimestamp(),
        "arrivals",
      );
    } catch (err) {
      logger.error(
        { err, userId: member.id },
        "Failed to log guild member add",
      );
    }
  });

  client.on("guildMemberRemove", async (member) => {
    try {
      await logToGuild(
        member.guild,
        new EmbedBuilder()
          .setTitle("Départ d’un membre")
          .setColor(0x95a5a6)
          .addFields({
            name: "Membre",
            value: `${member.user?.tag ?? "Inconnu"}\n\`${member.id}\``,
          })
          .setTimestamp(),
        "departures",
      );
    } catch (err) {
      logger.error(
        { err, userId: member.id },
        "Failed to log guild member remove",
      );
    }
  });
}

function formatMessageContent(content: string | null | undefined) {
  const normalized = (content ?? "[contenu indisponible]")
    .replaceAll("@", "@\u200b")
    .replaceAll("\n", " ");

  return normalized.length > 1200
    ? `${normalized.slice(0, 1200)}…`
    : normalized;
}
