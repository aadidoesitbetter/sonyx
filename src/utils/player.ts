import {
  Guild,
  TextChannel,
  User,
  VoiceChannel,
  Message,
  VoiceBasedChannel,
} from "discord.js";
import { Node, Player as ShoukakuPlayer, Connectors } from "shoukaku";
import { config } from "../config";
import { getOrCreateGuild, recordListening, prisma } from "./db";
import {
  addedToQueueEmbed,
  buildNowPlayingButtons,
  nowPlayingEmbed,
  trackEndedEmbed,
} from "./embeds";
import { buildSearchQuery, detectSource, formatDuration, isUrl } from "./format";
import { logger } from "./logger";

export type LoopMode = "off" | "track" | "queue";

export interface QueueTrack {
  title: string;
  artist: string;
  url: string;
  source: string;
  duration: number;
  artwork?: string;
  requester: User;
  encoded?: string;
  identifier?: string;
}

export interface ActiveFilters {
  bassboost: boolean;
  nightcore: boolean;
  eightD: boolean;
  karaoke: boolean;
  lowpass: boolean;
  tremolo: boolean;
  vibrato: boolean;
  rotation: boolean;
  pitch: number;
  speed: number;
  rate: number;
}

const DEFAULT_FILTERS: ActiveFilters = {
  bassboost: false,
  nightcore: false,
  eightD: false,
  karaoke: false,
  lowpass: false,
  tremolo: false,
  vibrato: false,
  rotation: false,
  pitch: 1,
  speed: 1,
  rate: 1,
};

export class GuildPlayer {
  guildId: string;
  queue: QueueTrack[] = [];
  history: QueueTrack[] = [];
  current: QueueTrack | null = null;
  loopMode: LoopMode = "off";
  volume = 100;
  paused = false;
  autoplay = false;
  announce = true;
  mode247 = false;
  filters: ActiveFilters = { ...DEFAULT_FILTERS };
  voiceChannelId: string | null = null;
  textChannelId: string | null = null;
  nowPlayingMessage: Message | null = null;
  progressInterval: NodeJS.Timeout | null = null;
  leaveTimeout: NodeJS.Timeout | null = null;
  shoukakuPlayer: ShoukakuPlayer | null = null;
  searchSource = "youtube";
  buttonStyle: "default" | "minimal" | "detailed" = "default";
  leaveCleanup = false;
  voteSkipEnabled = false;
  activeVoteSkip: Set<string> | null = null;

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  get node(): Node | undefined {
    return playerManager.shoukaku.getIdealNode() ?? undefined;
  }

  async ensurePlayer(voiceChannel: VoiceBasedChannel): Promise<ShoukakuPlayer> {
    const node = this.node;
    if (!node) throw new Error("No Lavalink nodes available");

    if (!this.shoukakuPlayer) {
      this.shoukakuPlayer = await playerManager.shoukaku.joinVoiceChannel({
        guildId: this.guildId,
        channelId: voiceChannel.id,
        shardId: 0,
        deaf: true,
      });
      this.shoukakuPlayer.on("end", () => this.onTrackEnd());
      this.shoukakuPlayer.on("exception", (data) => {
        logger.error({ guildId: this.guildId, data }, "Player exception");
        this.skip().catch(() => {});
      });
      this.shoukakuPlayer.on("stuck", () => {
        logger.warn({ guildId: this.guildId }, "Track stuck, skipping");
        this.skip().catch(() => {});
      });
    }

    this.voiceChannelId = voiceChannel.id;
    this.resetLeaveTimeout(voiceChannel as VoiceChannel);
    return this.shoukakuPlayer;
  }

  async resolve(
    query: string,
    requester: User,
    forceSource?: string
  ): Promise<QueueTrack[]> {
    const node = this.node;
    if (!node) throw new Error("Lavalink node is not connected");

    let search = query;
    if (!isUrl(query)) {
      const source = forceSource ?? this.searchSource;
      search = buildSearchQuery(source, query);
    }

    const result = await node.rest.resolve(search);
    if (!result) throw new Error("No results found for your search.");

    const data = result as any;
    if (data.loadType === "empty" || data.loadType === "error") {
      throw new Error("No results found for your search.");
    }

    const tracks: QueueTrack[] = [];
    const loadData = data.data;

    const mapTrack = (t: Record<string, unknown>): QueueTrack => ({
      title: (t.info as Record<string, string>).title,
      artist: (t.info as Record<string, string>).author,
      url: (t.info as Record<string, string>).uri ?? query,
      source: detectSource((t.info as Record<string, string>).uri ?? query),
      duration: Math.floor(((t.info as Record<string, number>).length ?? 0) / 1000),
      artwork: (t.info as Record<string, string>).artworkUrl,
      requester,
      encoded: t.encoded as string,
      identifier: (t.info as Record<string, string>).identifier,
    });

    if (data.loadType === "track") {
      tracks.push(mapTrack(loadData));
    } else if (data.loadType === "playlist") {
      for (const t of loadData.tracks) tracks.push(mapTrack(t));
    } else if (data.loadType === "search") {
      for (const t of loadData) tracks.push(mapTrack(t));
    }

    if (tracks.length === 0) throw new Error("No results found for your search.");
    return tracks;
  }

  async play(
    voiceChannel: VoiceBasedChannel,
    textChannel: TextChannel,
    query: string,
    requester: User,
    opts?: { front?: boolean; forceSource?: string }
  ): Promise<QueueTrack[]> {
    const tracks = await this.resolve(query, requester, opts?.forceSource);
    this.textChannelId = textChannel.id;

    // Join the voice channel before doing anything else
    await this.ensurePlayer(voiceChannel);

    if (opts?.front) {
      this.queue.unshift(...tracks);
    } else {
      this.queue.push(...tracks);
    }

    if (!this.current) {
      await this.startPlayback(voiceChannel, textChannel);
    } else if (this.announce) {
      const track = opts?.front ? tracks[0] : tracks[tracks.length - 1];
      const pos = opts?.front ? 1 : this.queue.length;
      await textChannel.send({
        embeds: [addedToQueueEmbed(track, pos)],
      });
    }

    return tracks;
  }

  async startPlayback(voiceChannel: VoiceBasedChannel, textChannel: TextChannel): Promise<void> {
    if (this.queue.length === 0) return;

    const track = this.queue.shift()!;
    this.current = track;
    this.paused = false;

    // Ensure we're connected (handles the case where the bot was disconnected between tracks)
    const player = await this.ensurePlayer(voiceChannel);

    await player.playTrack({ track: { encoded: track.encoded! } });
    await player.setGlobalVolume(this.volume);

    await this.applyFilters();
    await this.sendNowPlaying(textChannel);
    await recordListening(track.requester.id, this.guildId, {
      title: track.title,
      artist: track.artist,
      url: track.url,
      source: track.source,
      duration: track.duration,
    });
  }

  async sendNowPlaying(textChannel: TextChannel): Promise<void> {
    if (!this.current) return;

    const guildSettings = await getOrCreateGuild(this.guildId);
    this.buttonStyle = guildSettings.buttonStyle as typeof this.buttonStyle;

    const embed = nowPlayingEmbed(this.current, {
      position: 1,
      queueLength: this.queue.length + 1,
      volume: this.volume,
      loopMode: this.loopMode,
      elapsed: 0,
      paused: this.paused,
    });

    const components = buildNowPlayingButtons(this.paused, this.buttonStyle);

    if (this.nowPlayingMessage) {
      try {
        await this.nowPlayingMessage.edit({ embeds: [embed], components });
      } catch {
        this.nowPlayingMessage = await textChannel.send({ embeds: [embed], components });
      }
    } else {
      this.nowPlayingMessage = await textChannel.send({ embeds: [embed], components });
    }

    if (guildSettings.requestChannelId === textChannel.id) {
      try {
        await this.nowPlayingMessage.pin();
      } catch {
        /* may lack permission */
      }
    }

    this.startProgressUpdates();
    await this.updateVoiceStatus();
  }

  startProgressUpdates(): void {
    this.stopProgressUpdates();
    this.progressInterval = setInterval(async () => {
      if (!this.current || !this.nowPlayingMessage || this.paused) return;
      try {
        const position = this.shoukakuPlayer?.position ?? 0;
        const embed = nowPlayingEmbed(this.current, {
          position: 1,
          queueLength: this.queue.length + 1,
          volume: this.volume,
          loopMode: this.loopMode,
          elapsed: Math.floor(position / 1000),
          paused: this.paused,
        });
        await this.nowPlayingMessage.edit({
          embeds: [embed],
          components: buildNowPlayingButtons(this.paused, this.buttonStyle),
        });
      } catch {
        /* message deleted */
      }
    }, 10_000);
  }

  stopProgressUpdates(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  async onTrackEnd(): Promise<void> {
    if (!this.current) return;

    this.history.unshift(this.current);
    if (this.history.length > 50) this.history.pop();

    if (this.loopMode === "track" && this.current) {
      this.queue.unshift(this.current);
    } else if (this.loopMode === "queue" && this.current) {
      this.queue.push(this.current);
    }

    if (this.nowPlayingMessage) {
      try {
        await this.nowPlayingMessage.edit({
          embeds: [trackEndedEmbed(this.current)],
          components: [],
        });
      } catch {
        /* ignore */
      }
    }

    this.current = null;
    this.stopProgressUpdates();

    if (this.queue.length > 0) {
      const textChannel = await this.getTextChannel();
      const voiceChannel = await this.getVoiceChannel();
      if (textChannel && voiceChannel) await this.startPlayback(voiceChannel, textChannel);
    } else if (this.autoplay && this.history[0]) {
      await this.addSimilar(5);
      const textChannel = await this.getTextChannel();
      const voiceChannel = await this.getVoiceChannel();
      if (textChannel && voiceChannel && this.queue.length > 0) await this.startPlayback(voiceChannel, textChannel);
    } else {
      this.resetLeaveTimeout();
    }
  }

  async getTextChannel(): Promise<TextChannel | null> {
    if (!this.textChannelId) return null;
    const client = playerManager.client;
    const channel = await client.channels.fetch(this.textChannelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    return channel as TextChannel;
  }

  async getVoiceChannel(): Promise<VoiceBasedChannel | null> {
    if (!this.voiceChannelId) return null;
    const client = playerManager.client;
    const channel = await client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased()) return null;
    return channel as VoiceBasedChannel;
  }

  async skip(): Promise<void> {
    await this.shoukakuPlayer?.stopTrack();
  }

  async stop(): Promise<void> {
    this.queue = [];
    this.current = null;
    this.stopProgressUpdates();
    await this.shoukakuPlayer?.stopTrack();
    if (this.nowPlayingMessage) {
      try {
        await this.nowPlayingMessage.edit({ components: [] });
      } catch {
        /* ignore */
      }
    }
  }

  async pause(): Promise<void> {
    if (!this.shoukakuPlayer) return;
    await this.shoukakuPlayer.setPaused(true);
    this.paused = true;
    const channel = await this.getTextChannel();
    if (channel && this.current) await this.sendNowPlaying(channel);
  }

  async resume(): Promise<void> {
    if (!this.shoukakuPlayer) return;
    await this.shoukakuPlayer.setPaused(false);
    this.paused = false;
    const channel = await this.getTextChannel();
    if (channel && this.current) await this.sendNowPlaying(channel);
  }

  async setVolume(vol: number): Promise<void> {
    this.volume = Math.max(0, Math.min(200, vol));
    await this.shoukakuPlayer?.setGlobalVolume(this.volume);
  }

  async seek(seconds: number): Promise<void> {
    if (!this.current) return;
    const clamped = Math.max(0, Math.min(seconds, this.current.duration));
    await this.shoukakuPlayer?.seekTo(clamped * 1000);
  }

  cycleLoop(): LoopMode {
    const modes: LoopMode[] = ["off", "track", "queue"];
    const idx = modes.indexOf(this.loopMode);
    this.loopMode = modes[(idx + 1) % modes.length];
    return this.loopMode;
  }

  shuffle(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  removeDupes(): number {
    const seen = new Set<string>();
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => {
      const key = `${t.title}:${t.artist}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return before - this.queue.length;
  }

  async addSimilar(amount: number): Promise<void> {
    const ref = this.current ?? this.history[0];
    if (!ref) return;
    const node = this.node;
    if (!node) return;

    try {
      const result = await node.rest.resolve(`ytsearch:${ref.artist} ${ref.title}`);
      if (!result) return;
      const data = result as any;
      if (data.loadType !== "search") return;

      const tracks = (data.data as Record<string, unknown>[])
        .slice(0, amount)
        .map(
          (t): QueueTrack => ({
            title: (t.info as Record<string, string>).title,
            artist: (t.info as Record<string, string>).author,
            url: (t.info as Record<string, string>).uri,
            source: "YouTube",
            duration: Math.floor(((t.info as Record<string, number>).length ?? 0) / 1000),
            artwork: (t.info as Record<string, string>).artworkUrl,
            requester: ref.requester,
            encoded: t.encoded as string,
          })
        );

      this.queue.push(...tracks);
    } catch (err) {
      logger.error({ err }, "Failed to add similar songs");
    }
  }

  async applyFilters(): Promise<void> {
    const player = this.shoukakuPlayer;
    if (!player) return;

    const filters: Record<string, unknown> = {};
    const f = this.filters;

    if (f.bassboost) {
      filters.equalizer = [
        { band: 0, gain: 0.6 },
        { band: 1, gain: 0.4 },
        { band: 2, gain: 0.2 },
      ];
    }
    if (f.nightcore) {
      filters.timescale = { speed: 1.3, pitch: 1.3, rate: 1 };
    }
    if (f.eightD || f.rotation) {
      filters.rotation = { rotationHz: 0.2 };
    }
    if (f.karaoke) {
      filters.karaoke = { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 };
    }
    if (f.lowpass) {
      filters.lowPass = { smoothing: 20 };
    }
    if (f.tremolo) {
      filters.tremolo = { frequency: 4, depth: 0.75 };
    }
    if (f.vibrato) {
      filters.vibrato = { frequency: 4, depth: 0.75 };
    }
    if (f.pitch !== 1 || f.speed !== 1 || f.rate !== 1) {
      filters.timescale = {
        pitch: f.pitch,
        speed: f.speed,
        rate: f.rate,
      };
    }

    await player.setFilters(filters);
  }

  getActiveFilterNames(): string[] {
    const names: string[] = [];
    const f = this.filters;
    if (f.bassboost) names.push("Bassboost");
    if (f.nightcore) names.push("Nightcore");
    if (f.eightD) names.push("8D");
    if (f.karaoke) names.push("Karaoke");
    if (f.lowpass) names.push("Low-pass");
    if (f.tremolo) names.push("Tremolo");
    if (f.vibrato) names.push("Vibrato");
    if (f.rotation) names.push("Rotation");
    if (f.pitch !== 1) names.push(`Pitch (${f.pitch})`);
    if (f.speed !== 1) names.push(`Speed (${f.speed})`);
    if (f.rate !== 1) names.push(`Rate (${f.rate})`);
    return names;
  }

  resetFilters(): void {
    this.filters = { ...DEFAULT_FILTERS };
  }

  resetLeaveTimeout(voiceChannel?: VoiceChannel): void {
    if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
    if (this.mode247) return;

    this.leaveTimeout = setTimeout(async () => {
      const guild = playerManager.client.guilds.cache.get(this.guildId);
      const vc =
        voiceChannel ??
        (this.voiceChannelId
          ? ((await guild?.channels.fetch(this.voiceChannelId)) as VoiceChannel)
          : null);

      const members = vc?.members.filter((m) => !m.user.bot);
      if (!members?.size) {
        await this.destroy();
      }
    }, 5 * 60 * 1000);
  }

  async updateVoiceStatus(): Promise<void> {
    const guildSettings = await getOrCreateGuild(this.guildId);
    if (!guildSettings.announceEnabled || !this.voiceChannelId || !this.current) return;

    const guild = playerManager.client.guilds.cache.get(this.guildId);
    const vc = (await guild?.channels.fetch(this.voiceChannelId)) as VoiceChannel | undefined;
    if (!vc) return;

    try {
      // @ts-ignore
      if (typeof vc.setStatus === "function") await vc.setStatus(`🎵 ${this.current.title}`);
    } catch {
      /* not supported on all channel types */
    }
  }

  async destroy(): Promise<void> {
    this.stopProgressUpdates();
    if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
    this.queue = [];
    this.current = null;

    try {
      await playerManager.shoukaku.leaveVoiceChannel(this.guildId);
    } catch {
      /* already left */
    }

    this.shoukakuPlayer = null;
    this.voiceChannelId = null;
    playerManager.delete(this.guildId);
  }

  totalQueueDuration(): number {
    const current = this.current?.duration ?? 0;
    return current + this.queue.reduce((sum, t) => sum + t.duration, 0);
  }
}

class PlayerManager {
  players = new Map<string, GuildPlayer>();
  shoukaku!: import("shoukaku").Shoukaku;
  client!: import("discord.js").Client;

  get(guildId: string): GuildPlayer | undefined {
    return this.players.get(guildId);
  }

  getOrCreate(guildId: string): GuildPlayer {
    let player = this.players.get(guildId);
    if (!player) {
      player = new GuildPlayer(guildId);
      this.players.set(guildId, player);
    }
    return player;
  }

  delete(guildId: string): void {
    this.players.delete(guildId);
  }

  async loadGuildSettings(guildId: string): Promise<GuildPlayer> {
    const player = this.getOrCreate(guildId);
    const settings = await getOrCreateGuild(guildId);
    player.volume = settings.defaultVolume;
    player.autoplay = settings.autoplayEnabled;
    player.announce = settings.announceEnabled;
    player.mode247 = settings.mode247;
    player.searchSource = settings.searchSource;
    player.buttonStyle = settings.buttonStyle as GuildPlayer["buttonStyle"];
    player.leaveCleanup = settings.leaveCleanup;
    player.voteSkipEnabled = settings.voteSkipEnabled;
    return player;
  }
}

export const playerManager = new PlayerManager();
