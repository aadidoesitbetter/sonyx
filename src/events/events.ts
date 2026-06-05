import {
  Client,
  Events,
  Message,
  Interaction,
  VoiceState,
  ActivityType,
  TextChannel,
  ComponentType,
  GuildMember,
} from "discord.js";
import { registry, getPrefixArgs, CommandContext } from "../utils/commands";
import { getOrCreateGuild } from "../utils/db";
import { checkTextChannel } from "../utils/checks";
import { playerManager } from "../utils/player";
import { successEmbed } from "../utils/embeds";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { isUrl } from "../utils/format";
import { config } from "../config";

export function registerEvents(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    logger.info(`Logged in as ${c.user.tag}`);
    c.user.setActivity(configStatus(), { type: ActivityType.Playing });
    setInterval(() => {
      c.user?.setActivity(configStatus(), { type: ActivityType.Playing });
    }, 300_000);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;

    try {
      const guildSettings = await getOrCreateGuild(message.guild.id);

      // Song request channel — no prefix needed
      if (
        guildSettings.requestChannelId &&
        message.channelId === guildSettings.requestChannelId
      ) {
        await handleSongRequest(message);
        return;
      }

      const parsed = getPrefixArgs(message.content, guildSettings.prefix);
      if (!parsed) return;

      const cmd = registry.get(parsed.command);
      if (!cmd) return;

      const ctx: CommandContext = {
        guildId: message.guild.id,
        userId: message.author.id,
        args: parsed.args,
        message,
      };

      if (!(await checkTextChannel(ctx))) return;
      await cmd.execute(ctx);
    } catch (err) {
      logger.error({ err, guildId: message.guild.id }, "Message handler error");
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      const cmd = registry.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      if (interaction.isButton()) await handleButton(interaction);
      return;
    }

    const cmd = registry.get(interaction.commandName);
    if (!cmd || !interaction.guild) return;

    const ctx: CommandContext = {
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      args: [],
      interaction,
    };

    try {
      if (!(await checkTextChannel(ctx))) return;
      await cmd.execute(ctx);
    } catch (err) {
      logger.error({ err }, "Slash command error");
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const guildId = oldState.guild.id;
    const player = playerManager.get(guildId);
    if (!player) return;

    // Auto leave cleanup
    if (player.leaveCleanup && oldState.channelId && !newState.channelId) {
      const leftUserId = oldState.member?.id;
      if (leftUserId) {
        player.queue = player.queue.filter((t) => t.requester.id !== leftUserId);
      }
    }

    // Auto disconnect when VC empty
    const vcId = player.voiceChannelId;
    if (!vcId || player.mode247) return;

    const channel = oldState.guild.channels.cache.get(vcId);
    if (!channel?.isVoiceBased()) return;

    const members = channel.members.filter((m) => !m.user.bot);
    if (members.size === 0) {
      player.resetLeaveTimeout(channel as import("discord.js").VoiceChannel);
    } else if (player.leaveTimeout) {
      clearTimeout(player.leaveTimeout);
      player.leaveTimeout = null;
    }
  });
}

async function handleSongRequest(message: Message): Promise<void> {
  const content = message.content.trim();
  if (!content) {
    await message.delete().catch(() => {});
    return;
  }

  if (!isUrl(content) && content.startsWith(",")) {
    return; // let prefix commands through
  }

  const member = message.member as GuildMember;
  const vc = member?.voice.channel;
  if (!vc) {
    const reply = await message.reply({
      embeds: [successEmbed("Join a voice channel first!")],
    });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    await message.delete().catch(() => {});
    return;
  }

  const channel = message.channel as TextChannel;
  const player = await playerManager.loadGuildSettings(message.guild!.id);

  try {
    await player.ensurePlayer(vc);
    await player.play(vc, channel, content, message.author);
    const confirm = await channel.send({
      embeds: [successEmbed(`Queued **${content.slice(0, 50)}**`)],
    });
    setTimeout(() => confirm.delete().catch(() => {}), 5000);
  } catch (err) {
    const reply = await message.reply({
      embeds: [
        successEmbed(err instanceof Error ? err.message : "Could not play that."),
      ],
    });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
  }

  await message.delete().catch(() => {});

  // Delete non-music messages that aren't commands
  if (!isUrl(content) && content.length < 2) {
    await message.delete().catch(() => {});
  }
}

async function handleButton(
  interaction: import("discord.js").ButtonInteraction
): Promise<void> {
  if (!interaction.guild) return;
  const player = playerManager.get(interaction.guild.id);
  if (!player?.current) {
    await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
    return;
  }

  const channel = await player.getTextChannel();

  switch (interaction.customId) {
    case "np_pause":
      if (player.paused) await player.resume();
      else await player.pause();
      await interaction.deferUpdate();
      break;
    case "np_skip":
      await player.skip();
      await interaction.reply({ embeds: [successEmbed("Skipped.")], ephemeral: true });
      break;
    case "np_stop":
      await player.stop();
      await interaction.reply({ embeds: [successEmbed("Stopped.")], ephemeral: true });
      break;
    case "np_loop":
      player.cycleLoop();
      if (channel) await player.sendNowPlaying(channel);
      await interaction.deferUpdate();
      break;
    case "np_like":
      await prisma.likedSong.upsert({
        where: {
          userId_trackUrl: {
            userId: interaction.user.id,
            trackUrl: player.current!.url,
          },
        },
        update: {},
        create: {
          userId: interaction.user.id,
          trackTitle: player.current!.title,
          trackArtist: player.current!.artist,
          trackUrl: player.current!.url,
          trackSource: player.current!.source,
          durationSeconds: player.current!.duration,
        },
      });
      await interaction.reply({ embeds: [successEmbed("Added to favourites!")], ephemeral: true });
      break;
    case "np_rewind":
      await player.seek(
        Math.max(0, Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000) - 10)
      );
      await interaction.deferUpdate();
      break;
    case "np_forward":
      await player.seek(
        Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000) + 10
      );
      await interaction.deferUpdate();
      break;
    case "np_shuffle":
      player.shuffle();
      await interaction.reply({ embeds: [successEmbed("Queue shuffled.")], ephemeral: true });
      break;
  }
}

function configStatus(): string {
  return config.brand.status;
}
