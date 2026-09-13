"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useFormStatus } from "react-dom";
import {
  beginTotpAction,
  confirmTotpAction,
  disableTotpAction,
  type SecurityState,
} from "@/app/_actions/security";
import { ShieldCheckIcon, ShieldOffIcon, CopyIcon, CheckIcon } from "lucide-react";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking…" : label}
    </Button>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">
        Save these recovery codes now — they are shown once.
      </p>
      <p className="text-sm text-muted-foreground">
        Each works a single time, in place of your authenticator. They are the
        only way back in if you lose the device.
      </p>
      <pre className="grid grid-cols-2 gap-x-6 gap-y-1 rounded bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join("\n"));
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy all"}
      </Button>
    </div>
  );
}

export function TotpSettings({
  enabled,
  backupCodesRemaining,
}: {
  enabled: boolean;
  backupCodesRemaining: number;
}) {
  const [setup, setSetup] = React.useState<SecurityState | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [confirmState, confirmAction] = React.useActionState<SecurityState, FormData>(
    confirmTotpAction,
    {},
  );
  const [disableState, disableAction] = React.useActionState<SecurityState, FormData>(
    disableTotpAction,
    {},
  );

  if (confirmState.backupCodes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-emerald-600" />
            Two-factor authentication is on
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BackupCodes codes={confirmState.backupCodes} />
        </CardContent>
      </Card>
    );
  }

  if (enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-emerald-600" />
            Two-factor authentication
            <Badge variant="default">enabled</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign-in asks for a code from your authenticator.{" "}
            {backupCodesRemaining} recovery code
            {backupCodesRemaining === 1 ? "" : "s"} remaining.
            {backupCodesRemaining <= 2 && (
              <span className="text-amber-600">
                {" "}
                Running low — turn 2FA off and on again to get a fresh set.
              </span>
            )}
          </p>

          <form action={disableAction} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="disable-code" className="text-sm font-medium">
                Turn it off
              </label>
              <Input
                id="disable-code"
                name="code"
                placeholder="Current code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                className="w-40"
              />
            </div>
            <Button type="submit" variant="destructive">
              <ShieldOffIcon />
              Disable
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            A current code is required, so someone who has taken over an open
            session still cannot strip the second factor.
          </p>
          {disableState.error && (
            <p className="text-sm text-destructive">{disableState.error}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldOffIcon className="size-4 text-muted-foreground" />
          Two-factor authentication
          <Badge variant="secondary">off</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Zenstier runs commands as root across your fleet. With 2FA off, a
          single leaked password is all that stands in the way.
        </p>

        {!setup?.secret ? (
          <>
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () => setSetup(await beginTotpAction()))
              }
            >
              Set up two-factor authentication
            </Button>
            {setup?.error && (
              <p className="text-sm text-destructive">{setup.error}</p>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-6">
              <div
                className="rounded-lg border bg-white p-2"
                // Generated server-side by the qrcode package from our own URI.
                dangerouslySetInnerHTML={{ __html: setup.qrSvg ?? "" }}
              />
              <div className="space-y-2">
                <p className="text-sm">
                  Scan with any authenticator app, or enter the key by hand:
                </p>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-sm">
                  {setup.secret}
                </code>
                <p className="text-xs text-muted-foreground">
                  Algorithm SHA1 · 6 digits · 30-second period
                </p>
              </div>
            </div>

            <form action={confirmAction} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label htmlFor="code" className="text-sm font-medium">
                  Enter the code it shows
                </label>
                <Input
                  id="code"
                  name="code"
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  className="w-40 font-mono"
                />
              </div>
              <SubmitButton label="Confirm and enable" />
            </form>
            {confirmState.error && (
              <p className="text-sm text-destructive">{confirmState.error}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Nothing changes until a code is confirmed, so a mis-scanned code
              cannot lock you out.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
