import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLevel,
  buildEightBallResponseFields,
  getCurrentWeeklyMissionPeriod,
  getImageAttachmentUrls,
  getNextMonthlyLeaderboardRun,
  getNextWeeklyMissionRun,
  guardianLevelForXp,
  isBurst,
  isDuplicateBurst,
  levelTiersForLevel,
  nextMissionProgress,
  parseDuration,
  securityEscalationForDetectionCount,
  shouldLogMessageUpdate,
  trimWindow,
  xpForLevel,
  xpNeededForLevel,
} from "./discord-bot-utils.ts";
import {
  extractDiscordId,
  shouldDeletePrefixCommand,
  tokenizePrefixCommand,
} from "./discord-prefix.ts";
import {
  buildHelpPage,
  HELP_PAGE_BUTTON_PREFIX,
  HELP_PAGE_COUNT,
} from "./discord-help.ts";
import {
  buildServerConfigStatus,
  normalizeServerConfigPage,
  SERVER_CONFIG_PAGE_BUTTON_PREFIX,
  SERVER_CONFIG_PAGE_COUNT,
} from "./discord-server-config.ts";

test("parseDuration parses combined French duration units", () => {
  assert.equal(parseDuration("1j 2h 30m 5s"), 95_405_000);
  assert.equal(parseDuration("2d"), 172_800_000);
  assert.equal(parseDuration("365j"), 365 * 24 * 60 * 60 * 1000);
  assert.equal(parseDuration("0m"), null);
  assert.equal(parseDuration("sans durée"), null);
});

test("level thresholds are internally consistent", () => {
  assert.equal(xpNeededForLevel(0), 100);
  assert.equal(xpForLevel(0), 0);
  assert.deepEqual(calculateLevel(0), {
    level: 0,
    xpIntoLevel: 0,
    xpForNext: 100,
  });
  assert.deepEqual(calculateLevel(xpForLevel(3)), {
    level: 3,
    xpIntoLevel: 0,
    xpForNext: xpNeededForLevel(3),
  });
  assert.equal(calculateLevel(-50).level, 0);
});

test("level tiers are cumulative and fall away below their threshold", () => {
  assert.deepEqual(levelTiersForLevel(0), []);
  assert.deepEqual(levelTiersForLevel(1), [1]);
  assert.deepEqual(levelTiersForLevel(9), [1]);
  assert.deepEqual(levelTiersForLevel(10), [1, 2]);
  assert.deepEqual(levelTiersForLevel(19), [1, 2]);
  assert.deepEqual(levelTiersForLevel(20), [1, 2, 3]);
  assert.deepEqual(levelTiersForLevel(189), Array.from({ length: 19 }, (_, index) => index + 1));
  assert.deepEqual(levelTiersForLevel(190), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(
    levelTiersForLevel(999, 10, 20),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});

test("weekly mission jobs use Monday at noon UTC", () => {
  const mondayMorning = new Date("2026-08-10T10:00:00.000Z");

  assert.equal(
    new Date(getNextWeeklyMissionRun(mondayMorning)).toISOString(),
    "2026-08-10T12:00:00.000Z",
  );

  const missionPeriod = getCurrentWeeklyMissionPeriod(
    Date.parse("2026-08-10T13:00:00.000Z"),
  );
  assert.equal(missionPeriod.weekStart.toISOString(), "2026-08-10T12:00:00.000Z");
  assert.equal(missionPeriod.weekEnd.toISOString(), "2026-08-17T12:00:00.000Z");
});

test("monthly leaderboard runs on the last Saturday at noon UTC", () => {
  assert.equal(
    new Date(
      getNextMonthlyLeaderboardRun(new Date("2026-08-05T10:00:00.000Z")),
    ).toISOString(),
    "2026-08-29T12:00:00.000Z",
  );
  assert.equal(
    new Date(
      getNextMonthlyLeaderboardRun(new Date("2026-08-29T13:00:00.000Z")),
    ).toISOString(),
    "2026-09-26T12:00:00.000Z",
  );
});

test("prefix parsing supports quotes and Discord IDs", () => {
  assert.deepEqual(tokenizePrefixCommand('*ban "raison détaillée" <@123>'), [
    "*ban",
    "raison détaillée",
    "<@123>",
  ]);
  assert.equal(extractDiscordId("<@!123456>"), "123456");
  assert.equal(extractDiscordId("<#123456>"), "123456");
  assert.equal(extractDiscordId("123456"), "123456");
  assert.equal(extractDiscordId("not-an-id"), null);
});

test("deleted message logs recognize image attachments", () => {
  assert.deepEqual(
    getImageAttachmentUrls([
      { url: "https://cdn.test/photo.png", contentType: "image/png", name: "photo.png" },
      { url: "https://cdn.test/clip.mp4", contentType: "video/mp4", name: "clip.mp4" },
      { url: "https://cdn.test/unknown", contentType: null, name: "capture.webp" },
      { url: "https://cdn.test/file", contentType: "application/pdf", name: "file.pdf" },
    ]),
    ["https://cdn.test/photo.png", "https://cdn.test/unknown"],
  );
});

test("8ball response starts with the asking user", () => {
  assert.deepEqual(
    buildEightBallResponseFields(
      "CosmoUser#1234",
      "123456789",
      "Est-ce que je suis beau ?",
      "Oui, absolument.",
    ),
    [
      {
        name: "Utilisateur",
        value: "CosmoUser#1234\n`123456789`",
      },
      { name: "Question", value: "Est-ce que je suis beau ?" },
      { name: "Réponse", value: "Oui, absolument." },
    ],
  );
});

test("only member, fun, and animation prefix commands hide the source message", () => {
  for (const command of [
    "help",
    "ping",
    "server",
    "8ball",
    "announce",
    "poll",
    "dropxp",
  ]) {
    assert.equal(shouldDeletePrefixCommand(command), true);
  }

  for (const command of [
    "kick",
    "ban",
    "security",
    "maintenance",
    "set-xp",
    "unknown",
  ]) {
    assert.equal(shouldDeletePrefixCommand(command), false);
  }

  assert.equal(shouldDeletePrefixCommand("customrole"), true);
  assert.equal(shouldDeletePrefixCommand("CUSTOMROLE"), true);
});

test("help pagination exposes one category per page", () => {
  const firstPage = buildHelpPage(0);
  const lastPage = buildHelpPage(999);
  const firstEmbed = firstPage.embeds[0].toJSON();
  const lastEmbed = lastPage.embeds[0].toJSON();
  const firstButtons = firstPage.components[0].toJSON().components;
  const lastButtons = lastPage.components[0].toJSON().components;
  const firstButtonData = firstButtons as Array<{
    custom_id?: string;
    disabled?: boolean;
  }>;
  const lastButtonData = lastButtons as Array<{
    disabled?: boolean;
  }>;

  assert.equal(firstEmbed.title, "📚 Aide de CosmoBot");
  assert.match(firstEmbed.footer?.text ?? "", /Page 1\/5/);
  assert.match(firstEmbed.fields?.[0]?.name ?? "", /Commandes membres/);
  assert.equal(
    firstButtonData[0]?.custom_id,
    `${HELP_PAGE_BUTTON_PREFIX}home_0`,
  );
  assert.equal(firstButtonData[0]?.disabled, true);
  assert.equal(
    firstButtonData[1]?.custom_id,
    `${HELP_PAGE_BUTTON_PREFIX}previous_-1`,
  );
  assert.equal(
    firstButtonData[2]?.custom_id,
    `${HELP_PAGE_BUTTON_PREFIX}next_1`,
  );
  assert.equal(firstButtonData[2]?.disabled, false);

  assert.match(lastEmbed.footer?.text ?? "", /Page 5\/5/);
  assert.match(lastEmbed.fields?.[0]?.name ?? "", /Propriétaire/);
  assert.equal(lastButtonData[2]?.disabled, true);
});

test("help pagination creates a navigable next button on every non-final page", () => {
  for (let page = 0; page < HELP_PAGE_COUNT; page += 1) {
    const buttons = buildHelpPage(page).components[0].toJSON()
      .components as Array<{ custom_id?: string; disabled?: boolean }>;
    const nextButton = buttons[2];

    assert.equal(
      nextButton?.custom_id,
      `${HELP_PAGE_BUTTON_PREFIX}next_${page + 1}`,
    );
    assert.equal(nextButton?.disabled, page === HELP_PAGE_COUNT - 1);

    const customIds = buttons.map((button) => button.custom_id);
    assert.equal(new Set(customIds).size, customIds.length);
  }
});

test("server config status paginates by category with unique buttons", () => {
  const keys = [
    "log.messages",
    "role.warn",
    "channel.welcome",
    "setting.autoReactEmoji",
  ];
  const values = new Map([
    ["log.messages", "123"],
    ["role.warn", "456"],
    ["channel.welcome", null],
    ["setting.autoReactEmoji", "checking"],
  ]);

  for (let page = 0; page < SERVER_CONFIG_PAGE_COUNT; page += 1) {
    const status = buildServerConfigStatus(
      "Infinity Hub",
      keys,
      (key) => values.get(key) ?? null,
      page,
    );
    const buttons = status.components[0]!.toJSON().components as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;

    assert.equal(buttons.length, 3);
    assert.equal(new Set(buttons.map((button) => button.custom_id)).size, 3);
    assert.equal(
      buttons[2]?.custom_id,
      `${SERVER_CONFIG_PAGE_BUTTON_PREFIX}next_${page + 1}`,
    );
    assert.equal(
      buttons[2]?.disabled,
      page === SERVER_CONFIG_PAGE_COUNT - 1,
    );
  }
});

test("server config page normalization stays within category bounds", () => {
  assert.equal(normalizeServerConfigPage(-10), 0);
  assert.equal(normalizeServerConfigPage(999), SERVER_CONFIG_PAGE_COUNT - 1);
  assert.equal(normalizeServerConfigPage(Number.NaN), 0);
});

test("help documents recent security, maintenance, and Cosmo commands", () => {
  const pages = Array.from({ length: HELP_PAGE_COUNT }, (_, page) =>
    buildHelpPage(page).embeds[0]!.toJSON(),
  );
  const helpText = pages
    .flatMap((page) => page.fields ?? [])
    .map((field) => field.value)
    .join("\n");

  for (const command of [
    "*security config",
    "*security unlock",
    "*dropxp",
    "*cosmo mission-publish",
    "*maintenance on|off|status",
  ]) {
    assert.match(helpText, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(helpText, /Cosmo Gardien/);
  assert.doesNotMatch(helpText, /🎮 Animation/);
});

test("message update logging detects content and partial-message changes", () => {
  assert.equal(shouldLogMessageUpdate("avant", "après", false), true);
  assert.equal(shouldLogMessageUpdate("identique", "identique", false), false);
  assert.equal(shouldLogMessageUpdate(null, null, true), true);
});

test("security windows trim old events and detect bursts", () => {
  assert.deepEqual(trimWindow([0, 5, 12], 15, 10), [12]);
  assert.equal(isBurst([6, 8, 9], 10, 10, 3), true);
  assert.equal(isBurst([0, 8, 9], 10, 10, 3), false);
  assert.equal(isDuplicateBurst("same", "same", 2), true);
  assert.equal(isDuplicateBurst("same", "different", 2), false);
});

test("security detections escalate at the requested counts", () => {
  assert.equal(securityEscalationForDetectionCount(2), null);
  assert.deepEqual(securityEscalationForDetectionCount(3), {
    action: "temporary",
    durationMinutes: 1440,
  });
  assert.deepEqual(securityEscalationForDetectionCount(4), {
    action: "temporary",
    durationMinutes: 1440,
  });
  assert.deepEqual(securityEscalationForDetectionCount(5), {
    action: "permanent",
    durationMinutes: null,
  });
});

test("mission progress and guardian levels are bounded", () => {
  assert.deepEqual(nextMissionProgress(2, 3), {
    progress: 3,
    completed: true,
  });
  assert.deepEqual(nextMissionProgress(10, 3), {
    progress: 3,
    completed: true,
  });
  assert.equal(guardianLevelForXp(-20), 1);
  assert.equal(guardianLevelForXp(250), 3);
});
