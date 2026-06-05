"use client";

import { useEffect, useState } from "react";

export function WebPlayer() {
  const [guildId, setGuildId] = useState("");
  const [player, setPlayer] = useState<{
    current: { title: string; artist: string; artwork?: string } | null;
    queue: { title: string; artist: string }[];
    volume: number;
    paused: boolean;
  } | null>(null);

  async function load() {
    if (!guildId) return;
    const res = await fetch(`/api/guilds/${guildId}`);
    if (res.ok) {
      const data = await res.json();
      setPlayer(data.player);
    }
  }

  useEffect(() => {
    if (!guildId) return;
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [guildId]);

  async function action(act: string) {
    await fetch(`/api/guilds/${guildId}/player/${act}`, { method: "POST" });
    await load();
  }

  return (
    <div className="space-y-6">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-gray-400">Server ID</span>
        <input
          className="bg-white/10 rounded px-3 py-2"
          placeholder="Enter your Discord server ID"
          value={guildId}
          onChange={(e) => setGuildId(e.target.value)}
        />
      </label>

      {player?.current ? (
        <div className="p-6 rounded-xl bg-white/5 border border-white/10">
          <h2 className="text-2xl font-bold mb-1">{player.current.title}</h2>
          <p className="text-gray-400 mb-6">{player.current.artist}</p>

          <div className="w-full h-1 bg-white/10 rounded mb-6">
            <div className="h-full bg-sonyx-purple rounded w-1/3" />
          </div>

          <div className="flex gap-4 mb-6">
            <button
              onClick={() => action(player.paused ? "resume" : "pause")}
              className="w-12 h-12 rounded-full bg-sonyx-purple flex items-center justify-center text-xl"
            >
              {player.paused ? "▶" : "⏸"}
            </button>
            <button
              onClick={() => action("skip")}
              className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center"
            >
              ⏭
            </button>
            <button
              onClick={() => action("stop")}
              className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center"
            >
              ⏹
            </button>
          </div>

          <p className="text-sm text-gray-500">Volume: {player.volume}%</p>

          {player.queue.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold mb-2">Up Next</h3>
              <ul className="space-y-1 text-sm text-gray-400">
                {player.queue.slice(0, 10).map((t, i) => (
                  <li key={i}>
                    {i + 1}. {t.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : guildId ? (
        <p className="text-gray-400">No music playing in this server.</p>
      ) : null}
    </div>
  );
}
