import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { ServerPanel } from "@/components/ServerPanel";

export default async function ServerDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  const { id } = await params;

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-5xl mx-auto">
        <Link href="/dashboard" className="text-sonyx-purple hover:underline mb-6 inline-block">
          ← Back to servers
        </Link>
        <ServerPanel guildId={id} />
      </div>
    </main>
  );
}
