import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { Shoukaku, Connectors } from "shoukaku";
import { config } from "./config";
import { logger } from "./utils/logger";
import { playerManager } from "./utils/player";
import { registry } from "./utils/commands";
import { registerEvents } from "./events/events";
import { disconnectDb } from "./utils/db";
import { startApiServer } from "./api/server";

// Load all command modules
import "./commands/music";
import "./commands/queue";
import "./commands/filters";
import "./commands/playlists";
import "./commands/settings";
import "./commands/dj";
import "./commands/info";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [
    {
      name: "main",
      url: `${config.lavalink.host}:${config.lavalink.port}`,
      auth: config.lavalink.password,
      secure: false,
    },
  ],
  {
    moveOnDisconnect: true,
    resume: true,
    resumeTimeout: 60,
    reconnectTries: 5,
    restTimeout: 60,
  }
);

shoukaku.on("ready", (name) => {
  logger.info(`Lavalink node ${name} is ready`);
});

shoukaku.on("error", (name, error) => {
  logger.error({ name, error }, "Lavalink node error");
});

shoukaku.on("close", (name, code, reason) => {
  logger.warn({ name, code, reason }, "Lavalink node closed");
});

shoukaku.on("disconnect", (name, count) => {
  logger.warn({ name, count }, "Lavalink node disconnected");
});

playerManager.shoukaku = shoukaku;
playerManager.client = client;

registerEvents(client);

async function main(): Promise<void> {
  await registry.deploySlashCommands();
  startApiServer();
  await client.login(config.discord.token);
}

process.on("SIGINT", async () => {
  logger.info("Shutting down...");
  await disconnectDb();
  client.destroy();
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});

main().catch((err) => {
  logger.fatal({ err }, "Failed to start bot");
  process.exit(1);
});
