import {
  ChatInputCommandInteraction,
  GuildMember,
  Message,
  PermissionFlagsBits,
  VoiceChannel,
} from "discord.js";
import { CommandContext } from "./commands";
import { getOrCreateGuild, isDjCommandLocked } from "./db";
import { errorEmbed } from "./embeds";
import { playerManager } from "./player";

type InteractionLike = Message | ChatInputCommandInteraction;

export function getMember(ctx: CommandContext): GuildMember | null {
  if (ctx.interaction) {
    return (ctx.interaction.member as GuildMember) ?? null;
  }
  return (ctx.message?.member as GuildMember) ?? null;
}

export function getVoiceChannel(member: GuildMember | null): VoiceChannel | null {
  const channel = member?.voice.channel;
  if (!channel || channel.isVoiceBased() === false) return null;
  return channel as VoiceChannel;
}

export async function replyError(ctx: CommandContext, message: string): Promise<void> {
  const embed = errorEmbed(message);
  if (ctx.interaction) {
    if (ctx.interaction.replied || ctx.interaction.deferred) {
      await ctx.interaction.editReply({ embeds: [embed] });
    } else {
      await ctx.interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } else if (ctx.message) {
    await ctx.message.reply({ embeds: [embed] });
  }
}

export async function checkVoice(ctx: CommandContext): Promise<VoiceChannel | null> {
  const member = getMember(ctx);
  const userVc = getVoiceChannel(member);

  if (!userVc) {
    await replyError(ctx, "You must be in a voice channel to use this command.");
    return null;
  }

  const guildId = ctx.guildId;
  const player = playerManager.get(guildId);
  const botVc = player?.voiceChannelId;

  if (botVc && botVc !== userVc.id) {
    await replyError(
      ctx,
      "You must be in the same voice channel as the bot."
    );
    return null;
  }

  const settings = await getOrCreateGuild(guildId);
  if (
    settings.voiceChannelIds.length > 0 &&
    !settings.voiceChannelIds.includes(userVc.id)
  ) {
    await replyError(ctx, "Music is restricted to specific voice channels in this server.");
    return null;
  }

  return userVc;
}

export async function checkTextChannel(ctx: CommandContext): Promise<boolean> {
  const settings = await getOrCreateGuild(ctx.guildId);
  if (!settings.textChannelId) return true;

  const channelId = ctx.interaction?.channelId ?? ctx.message?.channelId;
  if (channelId !== settings.textChannelId) {
    await replyError(
      ctx,
      `Commands are restricted to <#${settings.textChannelId}> in this server.`
    );
    return false;
  }
  return true;
}

export async function checkDj(
  ctx: CommandContext,
  commandName: string
): Promise<boolean> {
  const member = getMember(ctx);
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  const guild = await getOrCreateGuild(ctx.guildId);
  if (!guild.djEnabled) return true;

  const locked = await isDjCommandLocked(ctx.guildId, commandName);
  if (!locked) return true;

  const hasDjRole = guild.djRoleIds.some((roleId) => member.roles.cache.has(roleId));
  if (!hasDjRole) {
    await replyError(ctx, "This command is locked to DJ roles.");
    return false;
  }
  return true;
}

export async function checkBotPermissions(
  ctx: CommandContext,
  voiceChannel: VoiceChannel
): Promise<boolean> {
  const me = voiceChannel.guild.members.me;
  if (!me) return false;

  const perms = voiceChannel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    await replyError(
      ctx,
      "I don't have permission to connect or speak in that voice channel."
    );
    return false;
  }
  return true;
}

export async function checkPlaying(ctx: CommandContext): Promise<boolean> {
  const player = playerManager.get(ctx.guildId);
  if (!player?.current) {
    await replyError(ctx, "Nothing is currently playing.");
    return false;
  }
  return true;
}

export async function checkQueue(ctx: CommandContext): Promise<boolean> {
  const player = playerManager.get(ctx.guildId);
  if (!player || player.queue.length === 0) {
    await replyError(ctx, "The queue is empty.");
    return false;
  }
  return true;
}
