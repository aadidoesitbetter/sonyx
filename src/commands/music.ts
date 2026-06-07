import {
  SlashCommandBuilder,
  Attachment,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { playerManager } from "../utils/player";
import {
  checkVoice,
  checkBotPermissions,
  checkPlaying,
  checkDj,
  getMember,
  replyError,
} from "../utils/checks";
import {
  addedToQueueEmbed,
  errorEmbed,
  grabEmbed,
  nowPlayingEmbed,
  pausedEmbed,
  successEmbed,
} from "../utils/embeds";
import { parseTimestamp, formatDuration } from "../utils/format";
import { fetchLyrics } from "../utils/lyrics";
import { sendPaginator, chunkArray } from "../utils/paginator";
import { baseEmbed } from "../utils/embeds";
import { generateMusicCard, generateMusicFrame } from "../utils/canvas";
import { AUDIO_EXTENSIONS } from "../config";
import { getOrCreateGuild } from "../utils/db";

async function getTextChannel(ctx: CommandContext): Promise<TextChannel | null> {
  const channel = ctx.interaction?.channel ?? ctx.message?.channel;
  if (!channel?.isTextBased()) return null;
  return channel as TextChannel;
}

async function handlePlay(
  ctx: CommandContext,
  query: string,
  opts?: { front?: boolean; skipCurrent?: boolean; forceSource?: string }
): Promise<void> {
  await ctx.interaction?.deferReply();

  const vc = await checkVoice(ctx);
  if (!vc) return;
  if (!(await checkBotPermissions(ctx, vc))) return;

  const textChannel = await getTextChannel(ctx);
  if (!textChannel) return;

  const member = getMember(ctx);
  if (!member) return;

  const player = await playerManager.loadGuildSettings(ctx.guildId);

  if (opts?.skipCurrent && player.current) {
    await player.skip();
  }

  try {
    const tracks = await player.play(vc, textChannel, query, member.user, {
      front: opts?.front,
      forceSource: opts?.forceSource,
    });

    const embed =
      tracks.length === 1
        ? addedToQueueEmbed(tracks[0], player.queue.length === 0 ? 1 : player.queue.length)
        : successEmbed(`Added **${tracks.length}** tracks to the queue.`);

    if (ctx.interaction) {
      if (ctx.interaction.deferred || ctx.interaction.replied) {
        await ctx.interaction.editReply({ embeds: [embed] });
      } else {
        await ctx.interaction.reply({ embeds: [embed] });
      }
    } else {
      await ctx.message!.reply({ embeds: [embed] });
    }
  } catch (err) {
    await replyError(ctx, err instanceof Error ? err.message : "Failed to play track.");
  }
}

function registerMusicCommands(): void {
  registry.register({
    name: "play",
    description: "Play a song or add it to the queue",
    aliases: ["p"],
    category: "Music",
    usage: ",play [query or URL]",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Song name or URL").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query") || "";
      if (!query) return replyError(ctx, "Please provide a song name or URL.");
      await handlePlay(ctx, query);
    },
  });

  registry.register({
    name: "playnext",
    description: "Add a song to the front of the queue",
    aliases: ["pn"],
    category: "Music",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Song name or URL").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query") || "";
      if (!query) return replyError(ctx, "Please provide a song name or URL.");
      await handlePlay(ctx, query, { front: true });
    },
  });

  registry.register({
    name: "playskip",
    description: "Skip current and play the given song",
    aliases: ["ps"],
    category: "Music",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Song name or URL").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query") || "";
      if (!query) return replyError(ctx, "Please provide a song name or URL.");
      await handlePlay(ctx, query, { skipCurrent: true });
    },
  });

  registry.register({
    name: "playfile",
    description: "Play an attached audio file",
    category: "Music",
    execute: async (ctx) => {
      const attachments =
        ctx.message?.attachments ??
        (ctx.interaction ? new Map() : new Map<string, Attachment>());
      const msgAttachments = ctx.message?.attachments;
      if (!msgAttachments?.size) {
        return replyError(ctx, "Attach an audio file (.mp3, .wav, .ogg, .flac, .m4a).");
      }
      const file = msgAttachments.first()!;
      const ext = file.name?.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ext || !AUDIO_EXTENSIONS.includes(ext)) {
        return replyError(ctx, "Unsupported file type.");
      }
      await handlePlay(ctx, file.url);
    },
  });

  registry.register({
    name: "youtube",
    description: "Force play from YouTube",
    category: "Music",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Song name or URL").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query") || "";
      if (!query) return replyError(ctx, "Please provide a query.");
      await handlePlay(ctx, query, { forceSource: "youtube" });
    },
  });

  registry.register({
    name: "pause",
    description: "Pause the current track",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      await player.pause();
      const embed = pausedEmbed();
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "resume",
    description: "Resume playback",
    category: "Music",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player?.current) return replyError(ctx, "Nothing is playing.");
      await player.resume();
      const embed = successEmbed("Playback resumed.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "stop",
    description: "Stop playback and clear the queue",
    category: "Music",
    djLock: true,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "stop"))) return;
      const player = playerManager.get(ctx.guildId);
      if (!player) return replyError(ctx, "Nothing is playing.");
      await player.stop();
      const embed = successEmbed("Stopped playback and cleared the queue.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "skip",
    description: "Skip to the next track",
    aliases: ["s"],
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const settings = await getOrCreateGuild(ctx.guildId);

      if (settings.voteSkipEnabled) {
        const member = getMember(ctx);
        const vc = member?.voice.channel;
        if (!vc) return;

        const voters = player.activeVoteSkip ?? new Set<string>();
        voters.add(ctx.userId);
        player.activeVoteSkip = voters;

        const needed = Math.ceil(
          vc.members.filter((m) => !m.user.bot).size / 2
        );
        if (voters.size < needed) {
          const embed = baseEmbed().setDescription(
            `Vote skip: **${voters.size}/${needed}** votes needed. React with ✅ or use \`,voteskip\`.`
          );
          if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
          else await ctx.message!.reply({ embeds: [embed] });
          return;
        }
        player.activeVoteSkip = null;
      }

      await player.skip();
      const embed = successEmbed("Skipped to the next track.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "skipto",
    description: "Skip to a specific queue position",
    category: "Music",
    djLock: true,
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("position").setDescription("Queue position").setRequired(true).setMinValue(1)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "skipto"))) return;
      const player = playerManager.get(ctx.guildId);
      if (!player) return replyError(ctx, "Nothing is playing.");

      const pos =
        parseInt(ctx.args[0] ?? "", 10) ||
        ctx.interaction?.options.getInteger("position", true) ||
        0;
      if (pos < 1 || pos > player.queue.length) {
        return replyError(ctx, "Invalid queue position.");
      }

      const target = player.queue.splice(pos - 1, 1)[0];
      player.queue.unshift(target);
      await player.skip();
      const embed = successEmbed(`Skipped to **${target.title}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "seek",
    description: "Seek to a position in the track",
    category: "Music",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("timestamp").setDescription("e.g. 1:30 or 90").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const input = ctx.args.join(" ") || ctx.interaction?.options.getString("timestamp") || "";
      const seconds = parseTimestamp(input);
      if (seconds === null) return replyError(ctx, "Invalid timestamp. Use mm:ss or seconds.");

      const player = playerManager.get(ctx.guildId)!;
      if (seconds > player.current!.duration) {
        return replyError(ctx, "Seek position is beyond track duration.");
      }
      await player.seek(seconds);
      const embed = successEmbed(`Seeked to **${formatDuration(seconds)}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "forward",
    description: "Fast forward by seconds",
    category: "Music",
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("seconds").setDescription("Seconds to forward").setRequired(false)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const amount =
        parseInt(ctx.args[0] ?? "10", 10) ||
        ctx.interaction?.options.getInteger("seconds") ||
        10;
      const player = playerManager.get(ctx.guildId)!;
      const pos = Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000) + amount;
      await player.seek(pos);
      const embed = successEmbed(`Forwarded **${amount}s**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "rewind",
    description: "Rewind by seconds",
    category: "Music",
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("seconds").setDescription("Seconds to rewind").setRequired(false)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const amount =
        parseInt(ctx.args[0] ?? "10", 10) ||
        ctx.interaction?.options.getInteger("seconds") ||
        10;
      const player = playerManager.get(ctx.guildId)!;
      const pos = Math.max(
        0,
        Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000) - amount
      );
      await player.seek(pos);
      const embed = successEmbed(`Rewound **${amount}s**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "replay",
    description: "Restart the current track",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      await player.seek(0);
      const embed = successEmbed("Replaying current track.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "loop",
    description: "Set or cycle loop mode",
    category: "Music",
    djLock: true,
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Loop mode")
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Track", value: "track" },
          { name: "Queue", value: "queue" }
        )
    ) as never,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "loop"))) return;
      const player = playerManager.getOrCreate(ctx.guildId);
      const mode = ctx.args[0] || ctx.interaction?.options.getString("mode") || "";
      if (mode && ["off", "track", "queue"].includes(mode)) {
        player.loopMode = mode as "off" | "track" | "queue";
      } else {
        player.cycleLoop();
      }
      const embed = successEmbed(`Loop mode: **${player.loopMode}**`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "volume",
    description: "Set or view playback volume",
    aliases: ["vol"],
    category: "Music",
    djLock: true,
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("level").setDescription("0-200").setMinValue(0).setMaxValue(200)
    ) as never,
    execute: async (ctx) => {
      const player = playerManager.getOrCreate(ctx.guildId);
      let level = parseInt(ctx.args[0] ?? "", 10);
      if (isNaN(level)) level = ctx.interaction?.options.getInteger("level") ?? NaN;

      if (isNaN(level)) {
        const embed = baseEmbed().setDescription(`Current volume: **${player.volume}%**`);
        if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
        else await ctx.message!.reply({ embeds: [embed] });
        return;
      }

      if (!(await checkDj(ctx, "volume"))) return;
      if (level < 0 || level > 200) return replyError(ctx, "Volume must be between 0 and 200.");
      await player.setVolume(level);
      const embed = successEmbed(`Volume set to **${level}%**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "nowplaying",
    description: "Show the currently playing track",
    aliases: ["np"],
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const elapsed = Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000);
      const embed = nowPlayingEmbed(player.current!, {
        position: 1,
        queueLength: player.queue.length + 1,
        volume: player.volume,
        loopMode: player.loopMode,
        elapsed,
        paused: player.paused,
      });
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "lyrics",
    description: "Get lyrics for the current song",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const lyrics = await fetchLyrics(player.current!.artist, player.current!.title);
      if (!lyrics) return replyError(ctx, "Could not find lyrics for this track.");

      const chunks = chunkArray(lyrics.split("\n"), 30);
      const embeds = chunks.map((lines, i) =>
        baseEmbed()
          .setTitle(i === 0 ? `📝 Lyrics — ${player.current!.title}` : "📝 Lyrics (cont.)")
          .setDescription(lines.join("\n").slice(0, 4000))
      );

      const target = ctx.interaction ?? ctx.message!;
      await sendPaginator(target as never, { embeds, userId: ctx.userId });
    },
  });

  registry.register({
    name: "grab",
    description: "DM yourself the current song info",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const member = getMember(ctx);
      if (!member) return;
      try {
        await member.send({ embeds: [grabEmbed(player.current!)] });
        const embed = successEmbed("Sent song info to your DMs!");
        if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed], ephemeral: true });
        else await ctx.message!.reply({ embeds: [embed] });
      } catch {
        await replyError(ctx, "I couldn't DM you. Check your privacy settings.");
      }
    },
  });

  registry.register({
    name: "join",
    description: "Join your voice channel",
    category: "Music",
    execute: async (ctx) => {
      const vc = await checkVoice(ctx);
      if (!vc) return;
      if (!(await checkBotPermissions(ctx, vc))) return;
      const player = playerManager.getOrCreate(ctx.guildId);
      await player.ensurePlayer(vc);
      const embed = successEmbed(`Joined **${vc.name}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "leave",
    description: "Leave the voice channel",
    aliases: ["disconnect", "dc"],
    category: "Music",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player?.voiceChannelId) return replyError(ctx, "I'm not in a voice channel.");
      await player.destroy();
      const embed = successEmbed("Left the voice channel.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "autoplay",
    description: "Toggle autoplay mode",
    category: "Music",
    execute: async (ctx) => {
      const player = playerManager.getOrCreate(ctx.guildId);
      player.autoplay = !player.autoplay;
      const embed = successEmbed(`Autoplay is now **${player.autoplay ? "ON" : "OFF"}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "247",
    description: "Toggle 24/7 mode",
    category: "Music",
    execute: async (ctx) => {
      const player = playerManager.getOrCreate(ctx.guildId);
      player.mode247 = !player.mode247;
      await getOrCreateGuild(ctx.guildId).then(async () => {
        const { updateGuild } = await import("../utils/db");
        await updateGuild(ctx.guildId, { mode247: player.mode247 });
      });
      const embed = successEmbed(`24/7 mode is now **${player.mode247 ? "ON" : "OFF"}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "announce",
    description: "Toggle track announcements",
    category: "Music",
    execute: async (ctx) => {
      const player = playerManager.getOrCreate(ctx.guildId);
      player.announce = !player.announce;
      const { updateGuild } = await import("../utils/db");
      await updateGuild(ctx.guildId, { announceEnabled: player.announce });
      const embed = successEmbed(`Announcements are now **${player.announce ? "ON" : "OFF"}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "card",
    description: "Generate a music card image",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const elapsed = Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000);
      const buffer = await generateMusicCard(player.current!, elapsed);
      const files = [{ attachment: buffer, name: "sonyx-card.png" }];
      if (ctx.interaction) await ctx.interaction.reply({ files });
      else await ctx.message!.reply({ files });
    },
  });

  registry.register({
    name: "frame",
    description: "Generate a music frame with lyrics",
    category: "Music",
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const lyrics =
        (await fetchLyrics(player.current!.artist, player.current!.title)) ??
        "Lyrics not available";
      const elapsed = Math.floor((player.shoukakuPlayer?.position ?? 0) / 1000);
      const buffer = await generateMusicFrame(player.current!, lyrics, elapsed);
      const files = [{ attachment: buffer, name: "sonyx-frame.png" }];
      if (ctx.interaction) await ctx.interaction.reply({ files });
      else await ctx.message!.reply({ files });
    },
  });
}

registerMusicCommands();
