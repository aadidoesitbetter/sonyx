"use client";

import { useEffect, useState } from "react";

interface PlayerState {
  current: { title: string; artist: string; url: string; duration: number } | null;
  queue: { title: string; artist: string; duration: number; requester: string }[];
  volume: number;
  paused: boolean;
  loopMode: string;
}

interface GuildSettings {
  prefix: string;
  searchSource: string;
  defaultVolume: number;
  autoplayEnabled: boolean;
  announceEnabled: boolean;
  voteSkipEnabled: boolean;
  mode247: boolean;
  djEnabled: boolean;
  buttonStyle: string;
}

export function ServerPanel({ guildId }: { guildId: string }) {
  const [settings, setSettings] = useState<GuildSettings | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/guilds/${guildId}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setSettings(data.settings);
      setPlayer(data.player);
      setError(null);
    } catch {
      setError("Could not connect to bot API. Is the bot running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [guildId]);

  async function action(act: string) {
    await fetch(`/api/guilds/${guildId}/player/${act}`, { method: "POST" });
    await load();
  }

  async function saveSettings(updates: Partial<GuildSettings>) {
    await fetch(`/api/guilds/${guildId}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    await load();
  }

  if (loading) return <p className="text-gray-400">Loading...</p>;
  if (error) return <p className="text-red-400">{error}</p>;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Server Control Panel</h1>

      <section className="p-6 rounded-xl bg-white/5 border border-white/10">
        <h2 className="text-xl font-semibold mb-4 text-sonyx-purple">Now Playing</h2>
        {player?.current ? (
          <div>
            <p className="text-lg font-medium">{player.current.title}</p>
            <p className="text-gray-400">{player.current.artist}</p>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => action(player.paused ? "resume" : "pause")}
                className="px-4 py-2 bg-sonyx-purple rounded-lg"
              >
                {player.paused ? "Resume" : "Pause"}
              </button>
              <button onClick={() => action("skip")} className="px-4 py-2 bg-white/10 rounded-lg">
                Skip
              </button>
              <button onClick={() => action("stop")} className="px-4 py-2 bg-red-600/80 rounded-lg">
                Stop
              </button>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Volume: {player.volume}% • Loop: {player.loopMode}
            </p>
          </div>
        ) : (
          <p className="text-gray-400">Nothing playing</p>
        )}
      </section>

      <section className="p-6 rounded-xl bg-white/5 border border-white/10">
        <h2 className="text-xl font-semibold mb-4 text-sonyx-purple">Queue</h2>
        {player?.queue?.length ? (
          <ul className="space-y-2">
            {player.queue.map((t, i) => (
              <li key={i} className="flex justify-between text-sm py-2 border-b border-white/5">
                <span>
                  {i + 1}. {t.title} — {t.artist}
                </span>
                <span className="text-gray-500">{t.requester}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-400">Queue is empty</p>
        )}
      </section>

      {settings && (
        <section className="p-6 rounded-xl bg-white/5 border border-white/10">
          <h2 className="text-xl font-semibold mb-4 text-sonyx-purple">Settings</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-gray-400">Prefix</span>
              <input
                className="bg-white/10 rounded px-3 py-2"
                defaultValue={settings.prefix}
                onBlur={(e) => saveSettings({ prefix: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-gray-400">Search Source</span>
              <select
                className="bg-white/10 rounded px-3 py-2"
                defaultValue={settings.searchSource}
                onChange={(e) => saveSettings({ searchSource: e.target.value })}
              >
                <option value="youtube">YouTube</option>
                <option value="youtubemusic">YouTube Music</option>
                <option value="spotify">Spotify</option>
                <option value="soundcloud">SoundCloud</option>
                <option value="deezer">Deezer</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-gray-400">Default Volume</span>
              <input
                type="number"
                min={1}
                max={200}
                className="bg-white/10 rounded px-3 py-2"
                defaultValue={settings.defaultVolume}
                onBlur={(e) => saveSettings({ defaultVolume: parseInt(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={settings.autoplayEnabled}
                onChange={(e) => saveSettings({ autoplayEnabled: e.target.checked })}
              />
              <span>Autoplay</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={settings.mode247}
                onChange={(e) => saveSettings({ mode247: e.target.checked })}
              />
              <span>24/7 Mode</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={settings.voteSkipEnabled}
                onChange={(e) => saveSettings({ voteSkipEnabled: e.target.checked })}
              />
              <span>Vote Skip</span>
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
