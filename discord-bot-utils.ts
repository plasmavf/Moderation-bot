const DAY_MS = 24 * 60 * 60 * 1000;

export function trimWindow(
  timestamps: readonly number[],
  now: number,
  windowMs: number,
): number[] {
  return timestamps.filter((timestamp) => now - timestamp < windowMs);
}

export function isBurst(
  timestamps: readonly number[],
  now: number,
  windowMs: number,
  threshold: number,
): boolean {
  return trimWindow(timestamps, now, windowMs).length >= threshold;
}

export function securityEscalationForDetectionCount(
  detectionCount: number,
): { action: "temporary" | "permanent"; durationMinutes: number | null } | null {
  if (detectionCount >= 5) {
    return { action: "permanent", durationMinutes: null };
  }
  if (detectionCount >= 3) {
    return { action: "temporary", durationMinutes: 24 * 60 };
  }
  return null;
}

export function isDuplicateBurst(
  previousContent: string | null | undefined,
  content: string,
  duplicateCount: number,
): boolean {
  return Boolean(previousContent && previousContent === content && duplicateCount >= 2);
}

export function getImageAttachmentUrls(
  attachments: readonly {
    url: string;
    contentType?: string | null;
    name?: string | null;
  }[],
): string[] {
  return attachments
    .filter((attachment) => {
      if (attachment.contentType?.toLowerCase().startsWith("image/")) {
        return true;
      }

      return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(
        attachment.name ?? attachment.url,
      );
    })
    .map((attachment) => attachment.url);
}

export function buildEightBallResponseFields(
  userTag: string,
  userId: string,
  question: string,
  answer: string,
): { name: string; value: string }[] {
  return [
    {
      name: "Utilisateur",
      value: `${userTag}\n\`${userId}\``,
    },
    { name: "Question", value: question },
    { name: "Réponse", value: answer },
  ];
}

export function shouldLogMessageUpdate(
  oldContent: string | null | undefined,
  newContent: string | null | undefined,
  oldMessagePartial: boolean,
): boolean {
  return oldMessagePartial || oldContent !== newContent;
}

export function guardianLevelForXp(guardianXp: number): number {
  return Math.max(1, Math.floor(Math.max(0, guardianXp) / 100) + 1);
}

export function nextMissionProgress(
  currentProgress: number,
  targetCount: number,
): { progress: number; completed: boolean } {
  const progress = Math.min(Math.max(0, currentProgress) + 1, Math.max(1, targetCount));
  return { progress, completed: progress >= targetCount };
}

export function parseDuration(input: string): number | null {
  const regex = /(\d+)\s*(j|d|h|m|s)/gi;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let matched = false;

  while ((match = regex.exec(input)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier =
      unit === "j" || unit === "d"
        ? DAY_MS
        : unit === "h"
          ? 60 * 60 * 1000
          : unit === "m"
            ? 60 * 1000
            : 1000;
    totalMs += value * multiplier;
  }

  return matched && totalMs > 0 ? totalMs : null;
}

export function xpNeededForLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

export function xpForLevel(level: number): number {
  let total = 0;
  for (let currentLevel = 0; currentLevel < level; currentLevel++) {
    total += xpNeededForLevel(currentLevel);
  }
  return total;
}

export function calculateLevel(totalXp: number): {
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
} {
  let level = 0;
  let remaining = Math.max(0, totalXp);

  while (remaining >= xpNeededForLevel(level)) {
    remaining -= xpNeededForLevel(level);
    level++;
  }

  return { level, xpIntoLevel: remaining, xpForNext: xpNeededForLevel(level) };
}

export function levelTiersForLevel(
  level: number,
  tierSize = 10,
  maxTiers = Number.MAX_SAFE_INTEGER,
): number[] {
  if (
    !Number.isFinite(level) ||
    !Number.isFinite(tierSize) ||
    tierSize <= 0 ||
    !Number.isFinite(maxTiers) ||
    maxTiers <= 0
  ) {
    return [];
  }

  const normalizedLevel = Math.floor(Math.max(0, level));
  if (normalizedLevel < 1) {
    return [];
  }

  const highestTier =
    normalizedLevel < tierSize
      ? 1
      : Math.floor(normalizedLevel / tierSize) + 1;
  return Array.from(
    { length: Math.min(highestTier, Math.floor(maxTiers)) },
    (_, index) => index + 1,
  );
}

export function getNextWeeklyMissionRun(now = new Date()): number {
  const next = new Date(now);
  const daysUntilMonday = (1 - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + daysUntilMonday);
  next.setUTCHours(12, 0, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }

  return next.getTime();
}

export function getCurrentWeeklyMissionPeriod(now = Date.now()) {
  const nextRun = getNextWeeklyMissionRun(new Date(now));
  return {
    weekStart: new Date(nextRun - 7 * DAY_MS),
    weekEnd: new Date(nextRun),
  };
}

function lastSaturdayOfMonth(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 12, 0, 0, 0));
  const daysSinceSaturday = (lastDay.getUTCDay() + 1) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - daysSinceSaturday);
  return lastDay.getTime();
}

export function getNextMonthlyLeaderboardRun(now = new Date()): number {
  const currentMonthRun = lastSaturdayOfMonth(
    now.getUTCFullYear(),
    now.getUTCMonth(),
  );

  return currentMonthRun > now.getTime()
    ? currentMonthRun
    : lastSaturdayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
}
