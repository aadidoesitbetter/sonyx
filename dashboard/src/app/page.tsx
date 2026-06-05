import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-8 py-6 border-b border-white/10">
        <span className="text-2xl font-bold text-sonyx-purple">Sonyx</span>
        <div className="flex gap-4">
          {session ? (
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-sonyx-purple rounded-lg hover:opacity-90 transition"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              href="/api/auth/signin"
              className="px-4 py-2 bg-sonyx-purple rounded-lg hover:opacity-90 transition"
            >
              Login with Discord
            </Link>
          )}
        </div>
      </nav>

      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-20">
        <h1 className="text-5xl md:text-7xl font-bold mb-6 bg-gradient-to-r from-sonyx-purple to-purple-300 bg-clip-text text-transparent">
          Sonyx
        </h1>
        <p className="text-xl text-gray-300 max-w-2xl mb-8">
          A fully featured Discord music bot — completely free. YouTube, Spotify,
          Apple Music, SoundCloud, and more. No paywalls. No tiers.
        </p>
        <div className="flex flex-wrap gap-4 justify-center">
          <Link
            href="/api/auth/signin"
            className="px-8 py-3 bg-sonyx-purple rounded-xl text-lg font-semibold hover:opacity-90 transition"
          >
            Login with Discord
          </Link>
          <Link
            href="/player"
            className="px-8 py-3 border border-sonyx-purple rounded-xl text-lg font-semibold hover:bg-sonyx-purple/20 transition"
          >
            Web Player
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 max-w-4xl w-full">
          {[
            { title: "All Sources", desc: "YouTube, Spotify, Apple Music, Deezer, Tidal & more" },
            { title: "Rich Controls", desc: "Filters, playlists, DJ mode, vote skip, 24/7" },
            { title: "100% Free", desc: "Every feature unlocked for everyone" },
          ].map((f) => (
            <div
              key={f.title}
              className="p-6 rounded-xl bg-white/5 border border-white/10"
            >
              <h3 className="text-lg font-semibold text-sonyx-purple mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="text-center py-6 text-gray-500 text-sm border-t border-white/10">
        Sonyx • sonyx.xyz
      </footer>
    </main>
  );
}
