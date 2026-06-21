import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import { Database, FileText, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState } from "react";
import { toast } from "sonner";

interface DataSourceBarProps {
  refreshIntervalMs: number;
}

const DATA_SOURCE_ICONS: Record<string, ReactNode> = {
  proxy: <Database className="h-3.5 w-3.5" />,
  session_log: <FileText className="h-3.5 w-3.5" />,
  codex_db: <Database className="h-3.5 w-3.5" />,
  codex_session: <FileText className="h-3.5 w-3.5" />,
  gemini_session: <FileText className="h-3.5 w-3.5" />,
  opencode_session: <FileText className="h-3.5 w-3.5" />,
};

export function DataSourceBar({ refreshIntervalMs }: DataSourceBarProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data: sources } = useQuery({
    queryKey: [...usageKeys.all, "data-sources"],
    queryFn: usageApi.getDataSourceBreakdown,
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    refetchIntervalInBackground: false,
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await usageApi.syncSessionUsage();
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
      if (result.imported > 0) {
        toast.success(
          t("usage.sessionSync.imported", {
            count: result.imported,
            defaultValue: "Imported {{count}} records from session logs",
          }),
        );
      } else if (result.errors.length > 0) {
        toast.warning(
          t("usage.sessionSync.partialFailed", {
            count: result.errors.length,
            defaultValue: "{{count}} session sync source failed",
          }),
        );
      } else {
        toast.info(
          t("usage.sessionSync.upToDate", {
            defaultValue: "Session logs are up to date",
          }),
        );
      }
    } catch {
      toast.error(
        t("usage.sessionSync.failed", {
          defaultValue: "Session sync failed",
        }),
      );
    } finally {
      setSyncing(false);
    }
  };

  const dataSources = sources ?? [];
  const hasNonProxy = dataSources.some((s) => s.dataSource !== "proxy");
  const syncLabel = hasNonProxy
    ? t("usage.sessionSync.resync", { defaultValue: "Sync" })
    : t("usage.sessionSync.import", {
        defaultValue: "Import Sessions",
      });
  const syncTooltip = t("usage.sessionSync.trigger", {
    defaultValue: "Sync session logs",
  });

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground bg-muted/30 rounded-lg px-4 py-2">
      <span className="font-medium text-foreground/70">
        {t("usage.dataSources", { defaultValue: "Data Sources" })}:
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-3 flex-wrap">
        {dataSources.length > 0 ? (
          dataSources.map((source) => (
            <div
              key={source.dataSource}
              className="flex items-center gap-1.5 bg-background/50 rounded-md px-2 py-1"
            >
              {DATA_SOURCE_ICONS[source.dataSource] ?? (
                <Database className="h-3.5 w-3.5" />
              )}
              <span>
                {t(`usage.dataSource.${source.dataSource}`, {
                  defaultValue: source.dataSource,
                })}
              </span>
              <span className="font-mono font-medium text-foreground/80">
                {source.requestCount.toLocaleString()}
              </span>
            </div>
          ))
        ) : (
          <span className="text-muted-foreground/80">
            {t("usage.sessionSync.emptyHint", {
              defaultValue: "No usage data yet",
            })}
          </span>
        )}
      </div>

      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 shrink-0 px-2 text-xs"
              onClick={handleSync}
              disabled={syncing}
              title={syncTooltip}
              aria-label={syncTooltip}
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span className="ml-1">{syncLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{syncTooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
