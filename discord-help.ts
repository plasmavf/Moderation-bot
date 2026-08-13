import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export const HELP_PAGE_BUTTON_PREFIX = "help_page_";

type HelpPage = {
  name: string;
  value: string;
};

const HELP_PAGES: HelpPage[] = [
  {
    name: "🌐 Commandes membres",
    value: [
      "`*help` — affiche cette aide",
      "`*ping` — vérifie que le bot répond",
      "`*server` — affiche les informations du serveur",
      "`*rank [user]` — affiche un niveau et l’XP",
      "`*profile view|edit` — consulte ou complète ton profil",
      "`*badge list [user]` — affiche les badges et le niveau Gardien",
      "`*leaderboard [limit]` — affiche le classement XP",
      "`*8ball question` · `*joke` — commandes détente",
      "`*dice [sides] [count]`",
    ].join("\n"),
  },
  {
    name: "🛡️ Modération",
    value: [
      "`*kick user [reason]` · `*ban user [reason]`",
      "`*ban [reason]` en réponse au message d’un membre",
      "`*unban user_id [reason]` · `*mute user minutes [reason]`",
      "`*demute user [reason]` · `*warn user [reason]` · `*unwarn user [reason]`",
      "`*clear amount` — supprime les messages récents du salon actuel",
      "`*clearmember user amount` — supprime les messages du membre dans le salon actuel",
      "`*lock [reason]` · `*unlock [reason]`",
      "`*security status` · `*security inspect [member]`",
      "`*security config feature enabled [threshold]`",
      "`*security lockdown` · `*security unlock`",
      "`*sanctions [user]` ou `*sanctions [action] [user]` · `*editsanction id [minutes] [reason]`",
    ].join("\n"),
  },
  {
    name: "🪐 Cosmo Shield",
    value: [
      "`*signaler user category description [evidence]`",
      "`*signalements [status] [priority]`",
      "`*signalement voir|prendre|note|priorite|statut|fermer ...`",
      "`*missions liste|progression|classement` · `*mission id`",
      "`*cosmo setup`",
      "`*cosmo mission-create` · `*cosmo mission-close`",
      "`*cosmo mission-validate` · `*cosmo mission-publish`",
      "Les missions peuvent progresser sur messages, arrivées ou signalements.",
      "Le rôle @Cosmo Gardien récompense les membres impliqués dans les missions : les validations donnent de l’XP Gardien et peuvent attribuer ce rôle. Le niveau Gardien est visible avec `*profile` et `*badge`.",
    ].join("\n"),
  },
  {
    name: "📈 Niveaux et rôles",
    value: [
      "`*set-xp member level|xp` · `*add-xp member level|xp`",
      "`*remove-xp member level|xp`",
      "`*levelroles status|set|remove|sync` — paliers 1-9, 10-19, …, 190+",
      "`*serverconfig set channel.levelUp <salon>` — salon des annonces de niveau",
      "`*customrole menu|list` · `*abs add|edit ...`",
      "`*dropxp amount` — drop d’XP réservé aux administrateurs",
      "Le leaderboard mensuel est publié automatiquement le dernier samedi du mois.",
    ].join("\n"),
  },
  {
    name: "👑 Propriétaire",
    value: [
      "`/owner` — ouvre le panneau propriétaire",
      "`/say message [channel]` — envoie un message comme le bot",
      "`*resetsanctions confirm` · `*resetmuteban confirm`",
      "`*forceleaderboard`",
      "`*backup create|list|restore` — sauvegardes owner-only",
      "`*resetlevels confirm` · `*resetmember member reset confirm`",
      "`*maintenance on|off|status` — bloque toutes les commandes sauf le propriétaire principal",
      "Le propriétaire principal conserve l’accès à toutes les commandes pendant la maintenance.",
    ].join("\n"),
  },
];

export const HELP_PAGE_COUNT = HELP_PAGES.length;

export function normalizeHelpPage(page: number): number {
  if (!Number.isFinite(page)) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(page), 0), HELP_PAGE_COUNT - 1);
}

export function buildHelpPage(page: number): {
  embeds: [EmbedBuilder];
  components: [ActionRowBuilder<ButtonBuilder>];
} {
  const safePage = normalizeHelpPage(page);
  const currentPage = HELP_PAGES[safePage]!;
  const embed = new EmbedBuilder()
    .setTitle("📚 Aide de CosmoBot")
    .setDescription(
      "Toutes les commandes utilisent le préfixe `*`. Utilise les boutons pour parcourir les catégories. Les commandes Slash `/owner` et `/say` sont réservées au propriétaire principal du bot.",
    )
    .setColor(0x5865f2)
    .addFields({
      name: currentPage.name,
      value: currentPage.value,
      inline: false,
    })
    .setFooter({
      text: `Page ${safePage + 1}/${HELP_PAGES.length} • Les permissions et rôles requis sont vérifiés pour chaque commande.`,
    });

  const components = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${HELP_PAGE_BUTTON_PREFIX}home_${safePage}`)
      .setLabel("Accueil")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`${HELP_PAGE_BUTTON_PREFIX}previous_${safePage - 1}`)
      .setLabel("◀ Précédent")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`${HELP_PAGE_BUTTON_PREFIX}next_${safePage + 1}`)
      .setLabel("Suivant ▶")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage === HELP_PAGES.length - 1),
  );

  return { embeds: [embed], components: [components] };
}
