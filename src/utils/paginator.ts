import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
  ChatInputCommandInteraction,
  ComponentType,
  Interaction,
} from "discord.js";

export interface PaginatorOptions {
  embeds: EmbedBuilder[];
  userId: string;
  timeout?: number;
}

export async function sendPaginator(
  target: Message | ChatInputCommandInteraction,
  options: PaginatorOptions
): Promise<void> {
  const { embeds, userId, timeout = 120_000 } = options;
  if (embeds.length === 0) return;

  let page = 0;

  const buildRow = (current: number) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("pg_prev")
        .setEmoji("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current === 0),
      new ButtonBuilder()
        .setCustomId("pg_next")
        .setEmoji("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current >= embeds.length - 1),
      new ButtonBuilder()
        .setCustomId("pg_stop")
        .setEmoji("⏹")
        .setStyle(ButtonStyle.Danger)
    );

  const embed = embeds[page].setFooter({
    text: `Page ${page + 1}/${embeds.length} • Sonyx • sonyx.xyz`,
  });

  let message: Message;
  if (target instanceof ChatInputCommandInteraction) {
    await target.reply({ embeds: [embed], components: [buildRow(page)] });
    message = (await target.fetchReply()) as Message;
  } else {
    message = await target.reply({ embeds: [embed], components: [buildRow(page)] });
  }

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeout,
    filter: (i: Interaction) =>
      i.isButton() && i.user.id === userId,
  });

  collector.on("collect", async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId === "pg_prev" && page > 0) page--;
    else if (interaction.customId === "pg_next" && page < embeds.length - 1) page++;
    else if (interaction.customId === "pg_stop") {
      collector.stop();
      await interaction.update({ components: [] });
      return;
    }

    const updated = embeds[page].setFooter({
      text: `Page ${page + 1}/${embeds.length} • Sonyx • sonyx.xyz`,
    });
    await interaction.update({ embeds: [updated], components: [buildRow(page)] });
  });

  collector.on("end", async () => {
    try {
      await message.edit({ components: [] });
    } catch {
      /* message may be deleted */
    }
  });
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
