import type { TransportDefinition, TransportId } from "./types";

const DISCORD_GATEWAY_CODE = `const discord = chat.getAdapter("discord");

const GATEWAY_CYCLE = 12 * 60 * 60 * 1000; // 12h
await discord
  .startGatewayListener({ waitUntil: () => {} }, GATEWAY_CYCLE)
  .then(() => {
    console.log("Gateway connected");
  })
  .catch((error) => {
    console.error("Error connecting gateway:", error);
  });
setInterval(
  () => {
    discord
      .startGatewayListener({ waitUntil: () => {} }, GATEWAY_CYCLE)
      .then(() => {
        console.log("Gateway reconnected");
      })
      .catch((error) => {
        console.error("Error reconnecting gateway:", error);
      });
  },
  GATEWAY_CYCLE - 1000,
);`;

const transports: TransportDefinition[] = [
  {
    id: "slack",
    displayName: "Slack",
    docsUrl: "https://www.chat-sdk.dev/docs/adapters/slack",
    adapterPackage: "@chat-adapter/slack",
    adapterImport: 'import { createSlackAdapter } from "@chat-adapter/slack";',
    adapterEntry: "    slack: createSlackAdapter(),",
    credentials: [
      {
        name: "Bot Token",
        envVar: "SLACK_BOT_TOKEN",
        description: "Bot User OAuth Token (xoxb-...)",
        isSecret: true,
      },
      {
        name: "Signing Secret",
        envVar: "SLACK_SIGNING_SECRET",
        description: "Signing secret for verifying requests",
        isSecret: true,
      },
    ],
  },
  {
    id: "discord",
    displayName: "Discord",
    docsUrl: "https://www.chat-sdk.dev/docs/adapters/discord",
    adapterPackage: "@chat-adapter/discord",
    adapterImport:
      'import { createDiscordAdapter } from "@chat-adapter/discord";',
    adapterEntry: "    discord: createDiscordAdapter(),",
    gatewayCode: DISCORD_GATEWAY_CODE,
    credentials: [
      {
        name: "Bot Token",
        envVar: "DISCORD_BOT_TOKEN",
        description: "Bot token from Discord developer portal",
        isSecret: true,
      },
      {
        name: "Public Key",
        envVar: "DISCORD_PUBLIC_KEY",
        description: "Public key for interaction verification",
        isSecret: false,
      },
      {
        name: "Application ID",
        envVar: "DISCORD_APPLICATION_ID",
        description: "Application ID from Discord developer portal",
        isSecret: false,
      },
    ],
  },
  {
    id: "teams",
    displayName: "Microsoft Teams",
    docsUrl: "https://www.chat-sdk.dev/docs/adapters/teams",
    adapterPackage: "@chat-adapter/teams",
    adapterImport: 'import { createTeamsAdapter } from "@chat-adapter/teams";',
    adapterEntry: "    teams: createTeamsAdapter(),",
    credentials: [
      {
        name: "App ID",
        envVar: "TEAMS_APP_ID",
        description: "Teams application (client) ID",
        isSecret: false,
      },
      {
        name: "App Password",
        envVar: "TEAMS_APP_PASSWORD",
        description: "Teams application password/secret",
        isSecret: true,
      },
    ],
  },
  {
    id: "gchat",
    displayName: "Google Chat",
    docsUrl: "https://www.chat-sdk.dev/docs/adapters/gchat",
    adapterPackage: "@chat-adapter/gchat",
    adapterImport:
      'import { createGoogleChatAdapter } from "@chat-adapter/gchat";',
    adapterEntry: "    gchat: createGoogleChatAdapter(),",
    credentials: [
      {
        name: "Credentials JSON",
        envVar: "GOOGLE_CHAT_CREDENTIALS",
        description: "Service account credentials JSON (single line)",
        isSecret: true,
      },
    ],
  },
];

const transportMap = new Map<TransportId, TransportDefinition>(
  transports.map((t) => [t.id, t]),
);

export function getTransport(id: TransportId): TransportDefinition {
  const t = transportMap.get(id);
  if (!t) throw new Error(`Unknown transport: ${id}`);
  return t;
}

export function getAllTransports(): TransportDefinition[] {
  return transports;
}
