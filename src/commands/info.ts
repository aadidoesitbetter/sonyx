import { SlashCommandBuilder } from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { config } from "../config";
import { playerManager } from "../utils/player";
import {
  getOrCreateUser,
  getTopArtists,
  prisma,
} from "../utils/db";
import { baseEmbed, profileEmbed } from "../utils/embeds";
import { sendPaginator, chunkArray } from "../utils/paginator";
import { formatDuration } from "../utils/format";
import discordJs from "discord.js";

const startTime = Date.now();

async function reply(ctx: CommandContext, embed: ReturnType<typeof baseEmbed>): Promise<void> {
  if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
  else await ctx.message!.reply({ embeds: [embed] });
}

function registerInfoCommands(): void {
  registry.register({
    name: "help",
    description: "Show command help",
    category: "Info",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("command").setDescription("Specific command name")
    ) as never,
    execute: async (ctx) => {
      const cmdName = ctx.args[0] || ctx.interaction?.options.getString("command");
      if (cmdName) {
        const cmd = registry.get(cmdName);
        if (!cmd) {
          const embed = baseEmbed().setDescription(`Command \`${cmdName}\` not found.`);
          return reply(ctx, embed);
        }
        const embed = baseEmbed()
          .setTitle(`Help: ${cmd.name}`)
          .setDescription(cmd.description)
          .addFields(
            { name: "Category", value: cmd.category, inline: true },
            { name: "Usage", value: cmd.usage ?? `,${cmd.name}`, inline: true },
            {
              name: "Aliases",
              value: cmd.aliases?.map((a) => `\`${a}\``).join(", ") || "None",
              inline: true,
            }
          );
        return reply(ctx, embed);
      }

      const categories = new Map<string, string[]>();
      for (const cmd of registry.commands.values()) {
        const list = categories.get(cmd.category) ?? [];
        list.push(`\`${cmd.name}\` — ${cmd.description}`);
        categories.set(cmd.category, list);
      }

      const pages = [...categories.entries()].map(([cat, cmds]) =>
        baseEmbed()
          .setTitle(`📖 Sonyx Help — ${cat}`)
          .setDescription(chunkArray(cmds, 8)[0].join("\n"))
      );

      const target = ctx.interaction ?? ctx.message!;
      await sendPaginator(target as never, { embeds: pages, userId: ctx.userId });
    },
  });

  registry.register({
    name: "about",
    description: "About Sonyx",
    category: "Info",
    execute: async (ctx) => {
      const client = ctx.interaction?.client ?? ctx.message?.client;
      const node = playerManager.shoukaku?.nodes?.values().next().value;
      const embed = baseEmbed()
        .setTitle("🎵 About Sonyx")
        .setDescription("A fully featured, completely free Discord music bot.")
        .addFields(
          { name: "Version", value: config.brand.version, inline: true },
          { name: "discord.js", value: discordJs.version, inline: true },
          { name: "Uptime", value: formatDuration(Math.floor((Date.now() - startTime) / 1000)), inline: true },
          { name: "Servers", value: `${client?.guilds.cache.size ?? 0}`, inline: true },
          { name: "Users", value: `${client?.users.cache.size ?? 0}`, inline: true },
          {
            name: "Lavalink",
            value: node?.state === 1 ? "🟢 Connected" : "🔴 Disconnected",
            inline: true,
          }
        );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "ping",
    description: "Show bot and Lavalink latency",
    category: "Info",
    execute: async (ctx) => {
      const sent = Date.now();
      const wsPing = ctx.interaction?.client.ws.ping ?? ctx.message?.client.ws.ping ?? 0;
      const node = playerManager.shoukaku?.nodes?.values().next().value;
      const embed = baseEmbed()
        .setTitle("🏓 Pong!")
        .addFields(
          { name: "Discord API", value: `${wsPing}ms`, inline: true },
          { name: "Round Trip", value: `${Date.now() - sent}ms`, inline: true },
          { name: "Lavalink", value: node ? "Connected" : "Disconnected", inline: true }
        );
      if (ctx.interaction) {
        await ctx.interaction.reply({ embeds: [embed] });
      } else {
        await ctx.message!.reply({ embeds: [embed] });
      }
    },
  });

  registry.register({
    name: "stats",
    description: "Global Sonyx statistics",
    category: "Info",
    execute: async (ctx) => {
      const client = ctx.interaction?.client ?? ctx.message?.client;
      const totalTracks = await prisma.user.aggregate({ _sum: { totalTracksPlayed: true } });
      const embed = baseEmbed()
        .setTitle("📊 Global Stats")
        .addFields(
          { name: "Servers", value: `${client?.guilds.cache.size ?? 0}`, inline: true },
          { name: "Users", value: `${client?.users.cache.size ?? 0}`, inline: true },
          {
            name: "Tracks Played",
            value: `${totalTracks._sum.totalTracksPlayed ?? 0}`,
            inline: true,
          },
          {
            name: "Uptime",
            value: formatDuration(Math.floor((Date.now() - startTime) / 1000)),
            inline: true,
          }
        );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "invite",
    description: "Get the bot invite link",
    category: "Info",
    execute: async (ctx) => {
      const perms = "36727824";
      const url = `https://discord.com/api/oauth2/authorize?client_id=${config.discord.clientId}&permissions=${perms}&scope=bot%20applications.commands`;
      const embed = baseEmbed()
        .setTitle("🔗 Invite Sonyx")
        .setDescription(`[Click here to invite Sonyx](${url})`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "support",
    description: "Get the support server link",
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("💬 Support")
        .setDescription(`Join our support server: ${config.links.support}`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "vote",
    description: "Vote for Sonyx on top.gg",
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("🗳 Vote for Sonyx")
        .setDescription(`Support us by voting: ${config.links.vote}`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "dashboard",
    description: "Get the web dashboard link",
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("🌐 Dashboard")
        .setDescription(`Manage your server at ${config.dashboard.url}/dashboard`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "webplayer",
    description: "Get the web player link",
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("🎧 Web Player")
        .setDescription(`Listen at ${config.dashboard.url}/player`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "musicpanel",
    description: "Get the music control panel link",
    aliases: ["music-panel"],
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("🎛 Music Panel")
        .setDescription(`Control music at ${config.dashboard.url}/dashboard`);
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "debug",
    description: "Run guild diagnostics",
    category: "Info",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("guild_id").setDescription("Guild ID to debug")
    ) as never,
    execute: async (ctx) => {
      const guildId = ctx.args[0] || ctx.interaction?.options.getString("guild_id") || ctx.guildId;
      const client = ctx.interaction?.client ?? ctx.message?.client;
      const guild = client?.guilds.cache.get(guildId);
      const player = playerManager.get(guildId);
      const node = playerManager.shoukaku?.nodes?.values().next().value;

      const embed = baseEmbed()
        .setTitle("🔧 Debug Info")
        .addFields(
          { name: "Guild", value: guild?.name ?? "Unknown", inline: true },
          { name: "Lavalink", value: node?.state === 1 ? "Connected" : "Disconnected", inline: true },
          { name: "Voice Channel", value: player?.voiceChannelId ? `<#${player.voiceChannelId}>` : "None", inline: true },
          { name: "Playing", value: player?.current?.title ?? "Nothing", inline: false },
          { name: "Queue Size", value: `${player?.queue.length ?? 0}`, inline: true },
          { name: "Paused", value: player?.paused ? "Yes" : "No", inline: true }
        );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "premium",
    description: "Sonyx premium info (everything is free!)",
    category: "Info",
    execute: async (ctx) => {
      const embed = baseEmbed()
        .setTitle("✨ Premium")
        .setDescription(
          "**Everything is free — enjoy!**\n\nSonyx has no paywalls, no tiers, and no restrictions. All features are available to everyone."
        );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "profile",
    description: "View a Sonyx user profile",
    category: "Info",
    slashData: new SlashCommandBuilder().addUserOption((o) =>
      o.setName("user").setDescription("User to view")
    ) as never,
    execute: async (ctx) => {
      const target =
        ctx.interaction?.options.getUser("user") ??
        ctx.message?.mentions.users.first() ??
        (ctx.interaction?.user ?? ctx.message?.author);
      if (!target) return;

      const user = await getOrCreateUser(target.id);
      const topArtists = await getTopArtists(target.id);
      const playlistCount = await prisma.playlist.count({ where: { ownerId: target.id } });
      const likedCount = await prisma.likedSong.count({ where: { userId: target.id } });

      const embed = profileEmbed(target, {
        totalTracks: user.totalTracksPlayed,
        totalSeconds: user.totalListeningSeconds,
        playlistCount,
        likedCount,
        topArtists,
        memberSince: user.createdAt,
      });

      await reply(ctx, embed);
    },
  });
}

registerInfoCommands();
