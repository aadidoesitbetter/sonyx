import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { getUserProfile } from "@/lib/api";

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const userId = (session.user as { id?: string }).id;
  let profile = null;
  try {
    if (userId) profile = await getUserProfile(userId);
  } catch {
    /* bot API may be offline */
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-3xl mx-auto">
        <Link href="/dashboard" className="text-sonyx-purple hover:underline mb-6 inline-block">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold mb-8">Your Profile</h1>

        <div className="p-6 rounded-xl bg-white/5 border border-white/10 mb-6">
          <p className="text-lg font-medium">{session.user?.name}</p>
          {profile?.user ? (
            <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
              <div>
                <span className="text-gray-400">Tracks Played</span>
                <p className="text-xl font-semibold">{profile.user.totalTracksPlayed}</p>
              </div>
              <div>
                <span className="text-gray-400">Listening Time</span>
                <p className="text-xl font-semibold">
                  {Math.floor(profile.user.totalListeningSeconds / 60)} min
                </p>
              </div>
            </div>
          ) : (
            <p className="text-gray-400 mt-2">Start listening with Sonyx to build your profile!</p>
          )}
        </div>

        {profile?.playlists?.length > 0 && (
          <section className="p-6 rounded-xl bg-white/5 border border-white/10 mb-6">
            <h2 className="text-xl font-semibold text-sonyx-purple mb-4">Playlists</h2>
            <ul className="space-y-2">
              {profile.playlists.map((p: { id: string; name: string; _count: { songs: number } }) => (
                <li key={p.id} className="text-sm">
                  {p.name} — {p._count.songs} songs
                </li>
              ))}
            </ul>
          </section>
        )}

        {profile?.history?.length > 0 && (
          <section className="p-6 rounded-xl bg-white/5 border border-white/10">
            <h2 className="text-xl font-semibold text-sonyx-purple mb-4">Recent History</h2>
            <ul className="space-y-2">
              {profile.history.slice(0, 20).map((h: { id: string; trackTitle: string; trackArtist: string }) => (
                <li key={h.id} className="text-sm text-gray-300">
                  {h.trackTitle} — {h.trackArtist}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
