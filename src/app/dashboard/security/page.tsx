import { requireUser } from "@/server/modules/auth/session";
import { totpStatus } from "@/server/modules/auth/totp.service";
import { TotpSettings } from "@/components/security/totp-settings";

export default async function SecurityPage() {
  const user = await requireUser();
  const status = await totpStatus(user.id);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Security settings for {user.email}.
      </p>
      <TotpSettings
        enabled={status.enabled}
        backupCodesRemaining={status.backupCodesRemaining}
      />
    </div>
  );
}
