import Link from "next/link";
import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { auditDetail, auditLabel } from "@/lib/audit-descriptions";

const PAGE_SIZE = 10;

function parsePage(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function Pager({
  page,
  total,
  param,
  otherParam,
  otherValue,
}: {
  page: number;
  total: number;
  param: string;
  otherParam: string;
  otherValue: number;
}) {
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  const href = (target: number) =>
    `/dashboard/history?${param}=${target}&${otherParam}=${otherValue}`;

  return (
    <div className="flex items-center justify-between gap-4 pt-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page} of {lastPage}
        </span>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          disabled={page <= 1}
          render={page <= 1 ? <button /> : <Link href={href(page - 1)} />}
        >
          <ChevronLeftIcon />
          <span className="sr-only">Previous page</span>
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          disabled={page >= lastPage}
          render={page >= lastPage ? <button /> : <Link href={href(page + 1)} />}
        >
          <ChevronRightIcon />
          <span className="sr-only">Next page</span>
        </Button>
      </div>
    </div>
  );
}

export default async function HistoryPage({
  searchParams,
}: PageProps<"/dashboard/history">) {
  const ctx = await requirePermissionPage("audit:read");
  // searchParams is a Promise in Next 16.
  const params = await searchParams;
  const cmdPage = parsePage(params.cmd);
  const auditPage = parsePage(params.audit);

  const [commands, commandCount, audit, auditCount] = await Promise.all([
    prisma.command.findMany({
      where: { teamId: ctx.team.id },
      orderBy: { createdAt: "desc" },
      skip: (cmdPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { device: { select: { name: true, deviceId: true } } },
    }),
    prisma.command.count({ where: { teamId: ctx.team.id } }),
    prisma.auditLog.findMany({
      where: { teamId: ctx.team.id },
      orderBy: { createdAt: "desc" },
      skip: (auditPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.auditLog.count({ where: { teamId: ctx.team.id } }),
  ]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Every command and credential change is recorded.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Command history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            {commands.length === 0 ? (
              <p className="text-sm text-muted-foreground">No commands yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Device</th>
                    <th className="py-2 pr-3 font-medium">Command</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Exit</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground">
                        {c.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        {c.device.name}
                      </td>
                      <td className="max-w-md py-2 pr-3">
                        <code className="block truncate font-mono text-xs">
                          {c.command}
                        </code>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          variant={
                            c.status === "SUCCEEDED"
                              ? "default"
                              : c.status === "FAILED" || c.status === "TIMEOUT"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {c.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="py-2 tabular-nums">{c.exitCode ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <Pager
            page={cmdPage}
            total={commandCount}
            param="cmd"
            otherParam="audit"
            otherValue={auditPage}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account activity</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1">
              {audit.map((a) => {
                const detail = auditDetail(a);
                return (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-sm last:border-0"
                  >
                    <span className="w-40 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {a.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </span>
                    <span className="font-medium">{auditLabel(a.action)}</span>
                    {detail && (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {detail}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Pager
            page={auditPage}
            total={auditCount}
            param="audit"
            otherParam="cmd"
            otherValue={cmdPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
