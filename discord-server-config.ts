import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export const SERVER_CONFIG_PAGE_BUTTON_PREFIX = "serverconfig_page_";
export const SERVER_CONFIG_PAGE_COUNT = 4;

const SERVER_CONFIG_CATEGORIES = [
  { prefix: "log", label: "📋 Journaux" },
  { prefix: "role", label: "🛡️ Rôles" },
  { prefix: "channel", label: "📺 Salons" },
  { prefix: "setting", label: "⚙️ Réglages" },
] as const;

export function normalizeServerConfigPage(page: number): number {
  if (!Number.isFinite(page)) {
    return 0;
  }

  return Math.min(
    Math.max(Math.trunc(page), 0),
    SERVER_CONFIG_PAGE_COUNT - 1,
  );
}

export function buildServerConfigStatus(
  guildName: string,
  keys: readonly string[],
  getValue: (key: string) => string | null,
  page: number,
): {
  embeds: [EmbedBuilder];
  components: [ActionRowBuilder<ButtonBuilder>];
} {
  const safePage = normalizeServerConfigPage(page);
  const category = SERVER_CONFIG_CATEGORIES[safePage]!;
  const categoryKeys = keys.filter((key) =>
    key.startsWith(`${category.prefix}.`),
  );
  const lines = categoryKeys.map(
    (key) => `• \`${key}\` : \`${getValue(key) ?? "non configuré"}\``,
  );

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ Configuration de ${guildName}`)
    .setColor(0x5865f2)
    .setDescription(
      "Utilise `*serverconfig set <clé> <valeur>` ou `none` pour effacer une valeur.",
    )
    .addFields({
      name: category.label,
      value: lines.join("\n") || "Aucune configuration dans cette catégorie.",
    })
    .setFooter({
      text: `Page ${safePage + 1}/${SERVER_CONFIG_PAGE_COUNT} • Cette configuration est propre à ce serveur.`,
    });

  const components = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SERVER_CONFIG_PAGE_BUTTON_PREFIX}home_${safePage}`)
      .setLabel("Accueil")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`${SERVER_CONFIG_PAGE_BUTTON_PREFIX}previous_${safePage - 1}`)
      .setLabel("◀ Précédent")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`${SERVER_CONFIG_PAGE_BUTTON_PREFIX}next_${safePage + 1}`)
      .setLabel("Suivant ▶")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === SERVER_CONFIG_PAGE_COUNT - 1),
  );

  return { embeds: [embed], components: [components] };
}
