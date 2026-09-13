import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/modules/auth/session";
import { acceptInvite, TeamError } from "@/server/modules/teams/team.service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default async function InvitePage({
  params,
}: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const user = await getCurrentUser();

  // Not signed in: send them to login and come back here afterwards.
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }

  let error: string | null = null;
  let teamName: string | null = null;
  try {
    const team = await acceptInvite(user.id, token);
    teamName = team.name;
  } catch (err) {
    if (err instanceof TeamError) error = err.message;
    else throw err;
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {error ? "Invite could not be accepted" : "Welcome to the team"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {error ?? `You are now a member of ${teamName}.`}
          </p>
          <Button render={<Link href="/dashboard" />}>Go to dashboard</Button>
        </CardContent>
      </Card>
    </div>
  );
}
