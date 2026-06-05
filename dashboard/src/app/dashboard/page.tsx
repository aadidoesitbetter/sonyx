import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";

interface Guild {
  id: string;
  name: string;
  icon: string | null;
  permissions: string;
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) redirect("/api/auth/signin");

  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    next: { revalidate: 60 },
  });

  const guilds: Guild[] = res.ok ? await res.json() : [];
  const manageable = guilds.filter((g) => (BigInt(g.permissions) & 0x20n) === 0x20n);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Your Servers</h1>
          <Link href="/profile" className="text-sonyx-purple hover:underline">
            Profile
          </Link>
        </div>

        {manageable.length === 0 ? (
          <p className="text-gray-400">
            No servers found where you have Manage Server permission.
          </p>
        ) : (
          <div className="grid gap-4">
            {manageable.map((guild) => (
              <Link
                key={guild.id}
                href={`/dashboard/${guild.id}`}
                className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/10 hover:border-sonyx-purple/50 transition"
              >
                {guild.icon ? (
                  <img
                    src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`}
                    alt=""
                    className="w-12 h-12 rounded-full"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-sonyx-purple/30 flex items-center justify-center font-bold">
                    {guild.name[0]}
                  </div>
                )}
                <span className="font-medium">{guild.name}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
