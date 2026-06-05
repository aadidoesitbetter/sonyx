import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  User,
} from "discord.js";
import { config } from "../config";
import { QueueTrack, LoopMode } from "./player";
import { formatDuration, createProgressBar } from "./format";

export function baseEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(config.brand.color)
    .setFooter({ text: config.brand.footer });
}

export function errorEmbed(message: string): EmbedBuilder {
  return baseEmbed()
    .setColor(config.brand.errorColor)
    .setTitle("❌ Error")
    .setDescription(message);
}

export function successEmbed(message: string): EmbedBuilder {
  return baseEmbed()
    .setColor(config.brand.successColor)
    .setTitle("✅ Success")
    .setDescription(message);
}

export function nowPlayingEmbed(
  track: QueueTrack,
  opts: {
    position: number;
    queueLength: number;
    volume: number;
    loopMode: LoopMode;
    elapsed?: number;
    paused?: boolean;
  }
): EmbedBuilder {
  const elapsed = opts.elapsed ?? 0;
  const bar = createProgressBar(elapsed, track.duration);
  const loopLabel =
    opts.loopMode === "track"
      ? "🔂 Track"
      : opts.loopMode === "queue"
        ? "🔁 Queue"
        : "Off";

  const embed = baseEmbed()
    .setTitle(opts.paused ? "⏸ Paused" : "🎵 Now Playing")
    .setURL(track.url)
    .setDescription(
      `**[${track.title}](${track.url})**\n` +
        `by **${track.artist}** • ${track.source}\n\n` +
        `${bar}\n` +
        `🔊 Volume: **${opts.volume}%** • Loop: **${loopLabel}**\n` +
        `📋 Track **${opts.position}** of **${opts.queueLength}** in queue`
    )
    .setThumbnail(track.artwork ?? null)
    .setAuthor({
      name: track.requester.tag,
      iconURL: track.requester.displayAvatarURL(),
    });

  return embed;
}

export function addedToQueueEmbed(track: QueueTrack, position: number): EmbedBuilder {
  return baseEmbed()
    .setTitle("✅ Added to Queue")
    .setDescription(`**[${track.title}](${track.url})**\nby **${track.artist}**`)
    .addFields(
      { name: "Position", value: `#${position}`, inline: true },
      { name: "Duration", value: formatDuration(track.duration), inline: true },
      { name: "Source", value: track.source, inline: true }
    )
    .setThumbnail(track.artwork ?? null)
    .setAuthor({
      name: track.requester.tag,
      iconURL: track.requester.displayAvatarURL(),
    });
}

export function trackEndedEmbed(track: QueueTrack): EmbedBuilder {
  return baseEmbed()
    .setTitle("⏹ Track Ended")
    .setDescription(`**[${track.title}](${track.url})**\nby **${track.artist}**`)
    .setThumbnail(track.artwork ?? null);
}

export function pausedEmbed(): EmbedBuilder {
  return baseEmbed().setTitle("⏸ Playback Paused").setDescription("Use `,resume` to continue.");
}

export function filtersEmbed(active: string[]): EmbedBuilder {
  const list =
    active.length > 0 ? active.map((f) => `• ${f}`).join("\n") : "No active filters";
  return baseEmbed()
    .setTitle("🎛 Audio Filters")
    .setDescription(list);
}

export function buildNowPlayingButtons(
  paused: boolean,
  style: "default" | "minimal" | "detailed" = "default"
): ActionRowBuilder<ButtonBuilder>[] {
  if (style === "minimal") {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("np_pause")
          .setEmoji(paused ? "▶️" : "⏸")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("np_skip")
          .setEmoji("⏭")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("np_pause")
      .setLabel(paused ? "Resume" : "Pause")
      .setEmoji(paused ? "▶️" : "⏸")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_skip")
      .setLabel("Skip")
      .setEmoji("⏭")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_stop")
      .setLabel("Stop")
      .setEmoji("⏹")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("np_loop")
      .setLabel("Loop")
      .setEmoji("🔁")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_like")
      .setLabel("Like")
      .setEmoji("❤️")
      .setStyle(ButtonStyle.Primary)
  );

  if (style === "detailed") {
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("np_rewind")
        .setLabel("Rewind 10s")
        .setEmoji("⏪")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("np_forward")
        .setLabel("Forward 10s")
        .setEmoji("⏩")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("np_shuffle")
        .setLabel("Shuffle")
        .setEmoji("🔀")
        .setStyle(ButtonStyle.Secondary)
    );
    return [row, row2];
  }

  return [row];
}

export function grabEmbed(track: QueueTrack): EmbedBuilder {
  return baseEmbed()
    .setTitle("🎵 Here's your song!")
    .setDescription(`**[${track.title}](${track.url})**\nby **${track.artist}**`)
    .addFields(
      { name: "Duration", value: formatDuration(track.duration), inline: true },
      { name: "Source", value: track.source, inline: true }
    )
    .setThumbnail(track.artwork ?? null);
}

export function profileEmbed(
  user: User,
  stats: {
    totalTracks: number;
    totalSeconds: number;
    playlistCount: number;
    likedCount: number;
    topArtists: { artist: string; count: number }[];
    memberSince: Date;
  }
): EmbedBuilder {
  const artists =
    stats.topArtists.length > 0
      ? stats.topArtists.map((a, i) => `${i + 1}. ${a.artist} (${a.count})`).join("\n")
      : "No data yet";

  return baseEmbed()
    .setTitle(`${user.username}'s Profile`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "Tracks Played", value: `${stats.totalTracks}`, inline: true },
      {
        name: "Listening Time",
        value: formatDuration(stats.totalSeconds),
        inline: true,
      },
      { name: "Playlists", value: `${stats.playlistCount}`, inline: true },
      { name: "Liked Songs", value: `${stats.likedCount}`, inline: true },
      { name: "Member Since", value: `<t:${Math.floor(stats.memberSince.getTime() / 1000)}:D>`, inline: true },
      { name: "Top Artists", value: artists }
    );
}
