const PREFIX_COMMANDS_WITH_HIDDEN_MESSAGES = new Set([
  // Commandes membres
  "help",
  "ping",
  "server",
  "rank",
  "profile",
  "badge",
  "leaderboard",
  "customrole",
  // Commandes fun
  "8ball",
  "joke",
  "dice",
  // Commandes d'animation
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
  "dropxp",
]);

export function shouldDeletePrefixCommand(commandName: string): boolean {
  return PREFIX_COMMANDS_WITH_HIDDEN_MESSAGES.has(commandName.toLowerCase());
}

export function tokenizePrefixCommand(input: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return tokens;
}

export function extractDiscordId(value: string): string | null {
  const mentionMatch = value.match(/^<(?:(?:@!?)|[#&])?(?<id>\d+)>$/);
  if (mentionMatch?.groups?.id) {
    return mentionMatch.groups.id;
  }

  const idMatch = value.match(/^(?<id>\d+)$/);
  return idMatch?.groups?.id ?? null;
}
