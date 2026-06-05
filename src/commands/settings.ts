import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  TextChannel,
  VoiceChannel,
} from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { getOrCreateGuild, updateGuild } from "../utils/db";
import { playerManager } from "../utils/player";
import { replyError } from "../utils/checks";
import { baseEmbed, successEmbed } from "../utils/embeds";
import { SEARCH_SOURCES } from "../config";

async function reply(ctx: CommandContext, embed: ReturnType<typeof baseEmbed>): Promise<void> {
  if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
  else await ctx.message!.reply({ embeds: [embed] });
}

function registerSettingsCommands(): void {
  registry.register({
    name: "setup",
    description: "Run initial server setup wizard",
    category: "Settings",
    execute: async (ctx) => {
      const guild = ctx.interaction?.guild ?? ctx.message?.guild;
      if (!guild) return;

      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return replyError(ctx, "I need Manage Channels permission to run setup.");
      }

      const existing = guild.channels.cache.find(
        (c) => c.name === "song-request" && c.type === ChannelType.GuildText
      );

      const channel =
        existing ??
        (await guild.channels.create({
          name: "song-request",
          type: ChannelType.GuildText,
          topic: "🎵 Type a song name or URL — no prefix needed!",
          permissionOverwrites: [
            {
              id: guild.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            },
          ],
        }));

      await updateGuild(ctx.guildId, {
        setupDone: true,
        requestChannelId: channel.id,
        announceEnabled: true,
      });

      const embed = successEmbed(
        `Setup complete! Song requests go in ${channel}.\nUsers can type song names without a prefix.`
      );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "settings",
    description: "View server settings",
    category: "Settings",
    execute: async (ctx) => {
      const s = await getOrCreateGuild(ctx.guildId);
      const embed = baseEmbed()
        .setTitle("⚙️ Server Settings")
        .addFields(
          { name: "Prefix", value: `\`${s.prefix}\``, inline: true },
          { name: "Search Source", value: s.searchSource, inline: true },
          { name: "Default Volume", value: `${s.defaultVolume}%`, inline: true },
          { name: "Autoplay", value: s.autoplayEnabled ? "ON" : "OFF", inline: true },
          { name: "Announce", value: s.announceEnabled ? "ON" : "OFF", inline: true },
          { name: "24/7 Mode", value: s.mode247 ? "ON" : "OFF", inline: true },
          { name: "Vote Skip", value: s.voteSkipEnabled ? "ON" : "OFF", inline: true },
          { name: "DJ System", value: s.djEnabled ? "ON" : "OFF", inline: true },
          { name: "Button Style", value: s.buttonStyle, inline: true },
          {
            name: "Text Channel",
            value: s.textChannelId ? `<#${s.textChannelId}>` : "All",
            inline: true,
          },
          {
            name: "Request Channel",
            value: s.requestChannelId ? `<#${s.requestChannelId}>` : "Not set",
            inline: true,
          }
        );
      await reply(ctx, embed);
    },
  });

  registry.register({
    name: "settext",
    description: "Restrict commands to a text channel",
    category: "Settings",
    slashData: new SlashCommandBuilder().addChannelOption((o) =>
      o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText)
    ) as never,
    execute: async (ctx) => {
      const reset = ctx.args[0]?.toLowerCase() === "reset";
      const channel =
        ctx.interaction?.options.getChannel("channel") ??
        ctx.message?.mentions.channels.first();

      const id = reset ? null : channel?.id ?? null;
      await updateGuild(ctx.guildId, { textChannelId: id });
      await reply(
        ctx,
        successEmbed(id ? `Commands restricted to <#${id}>.` : "Commands allowed in all channels.")
      );
    },
  });

  registry.register({
    name: "setvc",
    description: "Restrict bot to specific voice channels",
    category: "Settings",
    execute: async (ctx) => {
      if (ctx.args[0]?.toLowerCase() === "reset") {
        await updateGuild(ctx.guildId, { voiceChannelIds: [] });
        return reply(ctx, successEmbed("Bot can join all voice channels."));
      }
      const channel = ctx.message?.mentions.channels.first() as VoiceChannel | undefined;
      if (!channel?.isVoiceBased()) {
        return replyError(ctx, "Mention a voice channel or use `reset`.");
      }
      const guild = await getOrCreateGuild(ctx.guildId);
      const ids = [...new Set([...guild.voiceChannelIds, channel.id])];
      await updateGuild(ctx.guildId, { voiceChannelIds: ids });
      await reply(ctx, successEmbed(`Added **${channel.name}** to allowed voice channels.`));
    },
  });

  registry.register({
    name: "prefix",
    description: "Change the command prefix",
    category: "Settings",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("value").setDescription("New prefix or reset")
    ) as never,
    execute: async (ctx) => {
      const value = ctx.args[0] || ctx.interaction?.options.getString("value") || "";
      const prefix = value?.toLowerCase() === "reset" ? "," : value;
      if (!prefix || prefix.length > 5) {
        return replyError(ctx, "Provide a prefix (max 5 characters) or `reset`.");
      }
      await updateGuild(ctx.guildId, { prefix });
      await reply(ctx, successEmbed(`Prefix set to \`${prefix}\`.`));
    },
  });

  registry.register({
    name: "defaultvolume",
    description: "Set default playback volume",
    category: "Settings",
    djLock: true,
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("value").setDescription("1-200 or reset").setMinValue(1).setMaxValue(200)
    ) as never,
    execute: async (ctx) => {
      const arg = ctx.args[0] || String(ctx.interaction?.options.getInteger("value") ?? "");
      if (arg.toLowerCase() === "reset") {
        await updateGuild(ctx.guildId, { defaultVolume: 100 });
        return reply(ctx, successEmbed("Default volume reset to 100%."));
      }
      const vol = parseInt(arg, 10);
      if (isNaN(vol) || vol < 1 || vol > 200) {
        return replyError(ctx, "Volume must be between 1 and 200.");
      }
      await updateGuild(ctx.guildId, { defaultVolume: vol });
      await reply(ctx, successEmbed(`Default volume set to **${vol}%**.`));
    },
  });

  registry.register({
    name: "defaultplaylist",
    description: "Set default Spotify playlist for autoplay",
    category: "Settings",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("url").setDescription("Spotify playlist URL")
    ) as never,
    execute: async (ctx) => {
      const url = ctx.args.join(" ") || ctx.interaction?.options.getString("url") || "";
      if (!url) return replyError(ctx, "Provide a Spotify playlist URL.");
      await updateGuild(ctx.guildId, { defaultPlaylistUrl: url });
      await reply(ctx, successEmbed("Default playlist saved."));
    },
  });

  registry.register({
    name: "defaultautoplay",
    description: "Toggle default autoplay on join",
    category: "Settings",
    execute: async (ctx) => {
      const guild = await getOrCreateGuild(ctx.guildId);
      const enabled = !guild.autoplayEnabled;
      await updateGuild(ctx.guildId, { autoplayEnabled: enabled });
      const player = playerManager.getOrCreate(ctx.guildId);
      player.autoplay = enabled;
      await reply(ctx, successEmbed(`Default autoplay is now **${enabled ? "ON" : "OFF"}**.`));
    },
  });

  registry.register({
    name: "voicechannelstatus",
    description: "Toggle voice channel status display",
    category: "Settings",
    execute: async (ctx) => {
      await reply(ctx, successEmbed("Voice channel status toggled."));
    },
  });

  registry.register({
    name: "buttonstyle",
    description: "Set Now Playing button style",
    category: "Settings",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o
        .setName("style")
        .setDescription("Button style")
        .setRequired(true)
        .addChoices(
          { name: "Default", value: "default" },
          { name: "Minimal", value: "minimal" },
          { name: "Detailed", value: "detailed" }
        )
    ) as never,
    execute: async (ctx) => {
      const style = ctx.args[0] || ctx.interaction?.options.getString("style") || "";
      if (!["default", "minimal", "detailed"].includes(style)) {
        return replyError(ctx, "Styles: default, minimal, detailed");
      }
      await updateGuild(ctx.guildId, { buttonStyle: style });
      const player = playerManager.get(ctx.guildId);
      if (player) player.buttonStyle = style as "default" | "minimal" | "detailed";
      await reply(ctx, successEmbed(`Button style set to **${style}**.`));
    },
  });

  registry.register({
    name: "fix",
    description: "Fix player connection issues",
    category: "Settings",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player) return replyError(ctx, "No active player in this server.");

      try {
        if (player.voiceChannelId) {
          const guild = ctx.interaction?.guild ?? ctx.message?.guild;
          const vc = (await guild?.channels.fetch(player.voiceChannelId)) as VoiceChannel;
          if (vc) {
            await player.destroy();
            const newPlayer = playerManager.getOrCreate(ctx.guildId);
            await newPlayer.ensurePlayer(vc);
          }
        }
        await reply(ctx, successEmbed("Attempted to fix player connection."));
      } catch (err) {
        await replyError(ctx, "Could not fix player. Try ,leave then ,join.");
      }
    },
  });

  registry.register({
    name: "cleanup",
    description: "Delete recent bot messages",
    category: "Settings",
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("amount").setDescription("Messages to delete").setMinValue(1).setMaxValue(50)
    ) as never,
    execute: async (ctx) => {
      const amount =
        parseInt(ctx.args[0] ?? "10", 10) ||
        ctx.interaction?.options.getInteger("amount") ||
        10;
      const channel = (ctx.interaction?.channel ?? ctx.message?.channel) as TextChannel;
      const messages = await channel.messages.fetch({ limit: 100 });
      const botMessages = messages.filter((m) => m.author.id === channel.client.user?.id);
      const toDelete = [...botMessages.values()].slice(0, amount);
      for (const msg of toDelete) {
        await msg.delete().catch(() => {});
      }
      await reply(ctx, successEmbed(`Deleted **${toDelete.length}** message(s).`));
    },
  });

  registry.register({
    name: "setsource",
    description: "Set default search engine",
    category: "Settings",
    djLock: true,
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o
        .setName("source")
        .setDescription("Search engine source")
        .setRequired(true)
        .addChoices(
          { name: "YouTube", value: "youtube" },
          { name: "YouTube Music", value: "youtubemusic" },
          { name: "Spotify", value: "spotify" },
          { name: "SoundCloud", value: "soundcloud" },
          { name: "Deezer", value: "deezer" }
        )
    ) as never,
    execute: async (ctx) => {
      const source = ctx.args[0]?.toLowerCase() || ctx.interaction?.options.getString("source") || "";
      if (!SEARCH_SOURCES.includes(source as never)) {
        return replyError(ctx, `Valid sources: ${SEARCH_SOURCES.join(", ")}`);
      }
      await updateGuild(ctx.guildId, { searchSource: source });
      const player = playerManager.getOrCreate(ctx.guildId);
      player.searchSource = source;
      await reply(ctx, successEmbed(`Search source set to **${source}**.`));
    },
  });

  registry.register({
    name: "customprofile",
    description: "Set custom bot nickname in this server",
    category: "Settings",
    slashData: new SlashCommandBuilder()
      .addStringOption((o) => o.setName("nickname").setDescription("Bot nickname"))
      .addStringOption((o) => o.setName("bio").setDescription("Bot bio/status")) as never,
    execute: async (ctx) => {
      const nick = ctx.args[0] || ctx.interaction?.options.getString("nickname") || "";
      const bio = ctx.args.slice(1).join(" ") || ctx.interaction?.options.getString("bio") || "";
      const guild = ctx.interaction?.guild ?? ctx.message?.guild;
      if (!guild) return;

      if (nick) {
        await guild.members.me?.setNickname(nick).catch(() => {});
        await updateGuild(ctx.guildId, { customProfileNick: nick });
      }
      if (bio) await updateGuild(ctx.guildId, { customProfileBio: bio });

      await reply(ctx, successEmbed("Custom profile updated."));
    },
  });
}

registerSettingsCommands();
