import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { WebPlayer } from "@/components/WebPlayer";

export default async function PlayerPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-3xl mx-auto">
        <Link href="/" className="text-sonyx-purple hover:underline mb-6 inline-block">
          ← Home
        </Link>
        <h1 className="text-3xl font-bold mb-8">Web Player</h1>
        <WebPlayer />
      </div>
    </main>
  );
}
