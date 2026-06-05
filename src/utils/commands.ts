import {
  ChatInputCommandInteraction,
  Collection,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  AutocompleteInteraction,
} from "discord.js";
import { config } from "../config";
import { logger } from "./logger";

export interface CommandContext {
  guildId: string;
  userId: string;
  args: string[];
  interaction?: ChatInputCommandInteraction;
  message?: Message;
}

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  category: string;
  usage?: string;
  djLock?: boolean;
  slashData?: Omit<SlashCommandBuilder, "setName" | "setDescription">;
  execute: (ctx: CommandContext) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export class CommandRegistry {
  commands = new Collection<string, Command>();
  aliases = new Collection<string, string>();

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.aliases.set(alias, cmd.name);
    }
  }

  get(name: string): Command | undefined {
    return this.commands.get(name) ?? this.commands.get(this.aliases.get(name) ?? "");
  }

  async deploySlashCommands(): Promise<void> {
    const body = [...this.commands.values()].map((cmd) => {
      const builder = (cmd.slashData as SlashCommandBuilder) ?? new SlashCommandBuilder();
      builder.setName(cmd.name).setDescription(cmd.description.slice(0, 100));
      return builder.toJSON();
    });

    const rest = new REST({ version: "10" }).setToken(config.discord.token);
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
    logger.info(`Deployed ${body.length} slash commands`);
  }
}

export const registry = new CommandRegistry();

export function getPrefixArgs(content: string, prefix: string): {
  command: string;
  args: string[];
} | null {
  if (!content.startsWith(prefix)) return null;
  const without = content.slice(prefix.length).trim();
  if (!without) return null;
  const parts = without.split(/\s+/);
  return { command: parts[0].toLowerCase(), args: parts.slice(1) };
}
