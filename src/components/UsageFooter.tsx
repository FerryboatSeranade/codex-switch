import React from "react";
import { RefreshCw, AlertCircle, Clock, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type AppId } from "@/lib/api";
import { useUsageQuery } from "@/lib/query/queries";
import { UsageData, Provider } from "@/types";
import { TierBadge } from "@/components/SubscriptionQuotaFooter";
import { copyText } from "@/lib/clipboard";
import type { QuotaTier } from "@/types/subscription";

interface UsageFooterProps {
  provider: Provider;
  providerId: string;
  appId: AppId;
  usageEnabled: boolean; // 是否启用了用量查询
  isCurrent: boolean; // 是否为当前激活的供应商
  isInConfig?: boolean; // OpenCode: 是否已添加到配置
  inline?: boolean; // 是否内联显示（在按钮左侧）
}

interface IxGogoaiUsageMeta {
  type: "ix_gogoai_usage";
  keyName?: string;
  maskedKey?: string;
  group?: string;
  multiplier?: string | number;
  todayUsd?: number;
  last30Usd?: number;
  quotaLabel?: string;
  quotaUsed?: number;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaUnit?: string;
  quotaWindowStart?: string | null;
  resetsAt?: string | null;
  expiresAt?: string;
  status?: string;
  daysUntilExpiry?: number | null;
  mode?: string;
  createdAt?: string;
  updatedAt?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
}

/** UsageData → QuotaTier 转换（Token Plan 使用） */
function toQuotaTier(data: UsageData): QuotaTier {
  const extra = data.extra;
  if (extra && extra.startsWith("{")) {
    try {
      const parsed = JSON.parse(extra);
      return {
        name: data.planName || "",
        utilization: data.used || 0,
        resetsAt: parsed.resetsAt || null,
        usedValueUsd: parsed.usedValueUsd ?? null,
        maxValueUsd: parsed.maxValueUsd ?? null,
        planLabel: parsed.planLabel ?? null,
      };
    } catch {
      // fall through to plain string
    }
  }
  return {
    name: data.planName || "",
    utilization: data.used || 0,
    resetsAt: extra || null,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseIxGogoaiMeta(dataList: UsageData[]): IxGogoaiUsageMeta | null {
  for (const data of dataList) {
    if (!data.extra || !data.extra.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(data.extra) as Partial<IxGogoaiUsageMeta>;
      if (parsed.type === "ix_gogoai_usage") {
        return parsed as IxGogoaiUsageMeta;
      }
    } catch {
      // Ignore non-IX JSON extras.
    }
  }

  return null;
}

function formatUsd(value: number | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return "-";
  return `$${value.toFixed(digits)}`;
}

function normalizeIxQuotaUnit(value: unknown): string {
  if (typeof value !== "string") return "USD";

  const unit = value.trim();
  const lowerUnit = unit.toLowerCase();
  if (!unit || unit === "次" || unit === "美元" || unit === "$" || lowerUnit === "usd") {
    return "USD";
  }

  return unit;
}

function formatQuotaAmount(value: number, unit: string): string {
  return unit === "USD" ? value.toFixed(2) : value.toFixed(0);
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatResetCountdown(value: string | null | undefined): string {
  if (!value) return "-";

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;

  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return "已重置";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function quotaBarColor(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-orange-500";
  return "bg-emerald-500";
}

function maskApiKey(value: string | undefined): string {
  if (!value) return "sk-...";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const UsageFooter: React.FC<UsageFooterProps> = ({
  provider,
  providerId,
  appId,
  usageEnabled,
  isCurrent,
  isInConfig = false,
  inline = false,
}) => {
  const { t } = useTranslation();
  const isTokenPlan =
    provider.meta?.usage_script?.templateType === "token_plan";

  // 统一的用量查询（自动查询仅对当前激活的供应商启用）
  // OpenCode（累加模式）：使用 isInConfig 代替 isCurrent
  const shouldAutoQuery = appId === "opencode" ? isInConfig : isCurrent;
  const autoQueryInterval = shouldAutoQuery
    ? provider.meta?.usage_script?.autoQueryInterval || 0
    : 0;

  const {
    data: usage,
    isFetching: loading,
    lastQueriedAt,
    refetch,
  } = useUsageQuery(providerId, appId, {
    enabled: usageEnabled,
    autoQueryInterval,
  });

  // 🆕 定期更新当前时间，用于刷新相对时间显示
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    if (!lastQueriedAt) return;

    // 每30秒更新一次当前时间，触发相对时间显示的刷新
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 30000); // 30秒

    return () => clearInterval(interval);
  }, [lastQueriedAt]);

  // 只在启用用量查询且有数据时显示
  if (!usageEnabled || !usage) return null;

  // 错误状态
  if (!usage.success) {
    if (inline) {
      return (
        <div className="inline-flex items-center gap-2 text-xs rounded-lg border border-border-default bg-card px-3 py-2 shadow-sm">
          <div className="flex items-center gap-1.5 text-red-500 dark:text-red-400">
            <AlertCircle size={12} />
            <span>{t("usage.queryFailed")}</span>
          </div>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 flex-shrink-0"
            title={t("usage.refreshUsage")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      );
    }

    return (
      <div className="mt-3 rounded-xl border border-border-default bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-red-500 dark:text-red-400">
            <AlertCircle size={14} />
            <span>{usage.error || t("usage.queryFailed")}</span>
          </div>

          {/* 刷新按钮 */}
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 flex-shrink-0"
            title={t("usage.refreshUsage")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
    );
  }

  const usageDataList = usage.data || [];

  // 无数据时不显示
  if (usageDataList.length === 0) return null;

  const ixMeta = parseIxGogoaiMeta(usageDataList);
  if (provider.meta?.providerType === "ix_gogoai" && ixMeta) {
    return (
      <IxGogoaiUsageTable
        provider={provider}
        meta={ixMeta}
        loading={loading}
        lastQueriedAt={lastQueriedAt}
        now={now}
        onRefresh={() => refetch()}
      />
    );
  }

  // ── Token Plan：订阅风格内联渲染（百分比徽章 + 倒计时） ──
  if (isTokenPlan && inline) {
    return (
      <div className="flex flex-col items-end gap-1 text-xs whitespace-nowrap flex-shrink-0">
        {/* 第一行：查询时间 + 刷新 */}
        <div className="flex items-center gap-2 justify-end">
          <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
            <Clock size={10} />
            {lastQueriedAt
              ? formatRelativeTime(lastQueriedAt, now, t)
              : t("usage.never", { defaultValue: "从未更新" })}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              refetch();
            }}
            disabled={loading}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 flex-shrink-0 text-muted-foreground"
            title={t("usage.refreshUsage")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {/* 第二行：tier 徽章（复用官方订阅的 TierBadge） */}
        <div className="flex items-center gap-2">
          {(() => {
            const tiers = usageDataList.map((d) => toQuotaTier(d));
            const planLabel = tiers[0]?.planLabel;
            return (
              <>
                {planLabel && (
                  <span className="font-semibold text-muted-foreground">
                    💰 {planLabel}
                  </span>
                )}
                {tiers.map((tier, index) => (
                  <TierBadge key={index} tier={tier} t={t} />
                ))}
              </>
            );
          })()}
        </div>
      </div>
    );
  }

  // ── 通用用量：内联模式（原有逻辑） ──
  if (inline) {
    const firstUsage = usageDataList[0];
    const isExpired = firstUsage.isValid === false;

    return (
      <div className="flex flex-col items-end gap-1 text-xs whitespace-nowrap flex-shrink-0">
        {/* 第一行：更新时间和刷新按钮 */}
        <div className="flex items-center gap-2 justify-end">
          {/* 上次查询时间 */}
          <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
            <Clock size={10} />
            {lastQueriedAt
              ? formatRelativeTime(lastQueriedAt, now, t)
              : t("usage.never", { defaultValue: "从未更新" })}
          </span>

          {/* 刷新按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              refetch();
            }}
            disabled={loading}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 flex-shrink-0 text-muted-foreground"
            title={t("usage.refreshUsage")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* 第二行：用量和剩余 */}
        <div className="flex items-center gap-2">
          {/* 已用 */}
          {firstUsage.used !== undefined && (
            <div className="flex items-center gap-0.5">
              <span className="text-gray-500 dark:text-gray-400">
                {t("usage.used")}
              </span>
              <span className="tabular-nums text-gray-600 dark:text-gray-400 font-medium">
                {firstUsage.used.toFixed(2)}
              </span>
            </div>
          )}

          {/* 剩余 */}
          {firstUsage.remaining !== undefined && (
            <div className="flex items-center gap-0.5">
              <span className="text-gray-500 dark:text-gray-400">
                {t("usage.remaining")}
              </span>
              <span
                className={`font-semibold tabular-nums ${
                  isExpired
                    ? "text-red-500 dark:text-red-400"
                    : firstUsage.remaining <
                        (firstUsage.total || firstUsage.remaining) * 0.1
                      ? "text-orange-500 dark:text-orange-400"
                      : "text-green-600 dark:text-green-400"
                }`}
              >
                {firstUsage.remaining.toFixed(2)}
              </span>
            </div>
          )}

          {/* 单位 */}
          {firstUsage.unit && (
            <span className="text-gray-500 dark:text-gray-400">
              {firstUsage.unit}
            </span>
          )}

          {/* 扩展字段 extra */}
          {firstUsage.extra && (
            <span
              className="text-gray-500 dark:text-gray-400 truncate max-w-[150px]"
              title={firstUsage.extra}
            >
              {firstUsage.extra}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-border-default bg-card px-4 py-3 shadow-sm">
      {/* 标题行：包含刷新按钮和自动查询时间 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
          {t("usage.planUsage")}
        </span>
        <div className="flex items-center gap-2">
          {/* 自动查询时间提示 */}
          {lastQueriedAt && (
            <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
              <Clock size={10} />
              {formatRelativeTime(lastQueriedAt, now, t)}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
            title={t("usage.refreshUsage")}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* 套餐列表 */}
      <div className="flex flex-col gap-3">
        {usageDataList.map((usageData, index) => (
          <UsagePlanItem key={index} data={usageData} />
        ))}
      </div>
    </div>
  );
};

// ── 通用用量组件 ────────────────────────────────────────────

const IxGogoaiUsageTable: React.FC<{
  provider: Provider;
  meta: IxGogoaiUsageMeta;
  loading: boolean;
  lastQueriedAt?: number | null;
  now: number;
  onRefresh: () => void;
}> = ({ provider, meta, loading, lastQueriedAt, now, onRefresh }) => {
  const { t } = useTranslation();
  const apiKey = provider.settingsConfig?.auth?.OPENAI_API_KEY;
  const used = isFiniteNumber(meta.quotaUsed) ? meta.quotaUsed : 0;
  const total = isFiniteNumber(meta.quotaLimit) ? meta.quotaLimit : 0;
  const remaining = isFiniteNumber(meta.quotaRemaining)
    ? meta.quotaRemaining
    : Math.max(total - used, 0);
  const percent = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const status = String(meta.status || "active").toLowerCase();
  const isActive =
    status !== "inactive" && status !== "disabled" && status !== "false";
  const quotaUnit = normalizeIxQuotaUnit(meta.quotaUnit);
  const copiedKeyText =
    typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : "";
  const copyApiKey = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!copiedKeyText) {
      toast.error("没有可复制的 API Key");
      return;
    }

    try {
      await copyText(copiedKeyText);
      toast.success("API Key 已复制");
    } catch (error) {
      console.warn("[IX] Failed to copy API key:", error);
      toast.error("复制 API Key 失败");
    }
  };

  return (
    <div className="mt-3 overflow-x-auto">
      <div className="min-w-[900px] text-xs">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="font-medium text-foreground">IX 用量</span>
            <span className="tabular-nums">
              {meta.startDate || "-"} ~ {meta.endDate || "-"}
            </span>
            {meta.timezone && <span>{meta.timezone}</span>}
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            {lastQueriedAt && (
              <span className="flex items-center gap-1 text-[10px]">
                <Clock size={10} />
                {formatRelativeTime(lastQueriedAt, now, t)}
              </span>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRefresh();
              }}
              disabled={loading}
              className="rounded p-1 transition-colors hover:bg-muted disabled:opacity-50"
              title={t("usage.refreshUsage")}
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(130px,1fr)_150px_105px_150px_minmax(170px,1fr)_150px_72px_88px] items-center border-b border-border-default pb-2 text-[11px] font-medium text-muted-foreground">
          <span>名称</span>
          <span>Key</span>
          <span>分组</span>
          <span>消耗</span>
          <span>7d 限额</span>
          <span>过期</span>
          <span>状态</span>
          <span>到期剩余</span>
        </div>

        <div className="grid grid-cols-[minmax(130px,1fr)_150px_105px_150px_minmax(170px,1fr)_150px_72px_88px] items-center gap-y-2 py-3">
          <div className="min-w-0 pr-3">
            <div
              className="truncate font-medium text-foreground"
              title={meta.keyName || "default"}
            >
              {meta.keyName || "default"}
            </div>
          </div>

          <div className="min-w-0 pr-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <code
                className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={maskApiKey(copiedKeyText) || meta.maskedKey || "sk-..."}
              >
                {maskApiKey(copiedKeyText) || meta.maskedKey || "sk-..."}
              </code>
              <button
                type="button"
                onClick={copyApiKey}
                disabled={!copiedKeyText}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  copiedKeyText ? "复制完整 API Key" : "没有可复制的 API Key"
                }
                aria-label={
                  copiedKeyText ? "复制完整 API Key" : "没有可复制的 API Key"
                }
              >
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div className="min-w-0 pr-3">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400">
              <span className="truncate">{meta.group || "codex"}</span>
              <span className="rounded bg-black/10 px-1 py-0.5 text-[10px] dark:bg-white/10">
                {meta.multiplier || "1x"}
              </span>
            </span>
          </div>

          <div className="space-y-0.5 pr-3">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">今日:</span>
              <span className="tabular-nums font-medium text-foreground">
                {formatUsd(meta.todayUsd, 4)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">近30天:</span>
              <span className="tabular-nums font-medium text-foreground">
                {formatUsd(meta.last30Usd, 4)}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 pr-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {meta.quotaLabel || "7d"}
              </span>
              <span className="tabular-nums font-medium text-foreground">
                {formatQuotaAmount(used, quotaUnit)}/
                {formatQuotaAmount(total, quotaUnit)} {quotaUnit}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${quotaBarColor(percent)}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="tabular-nums text-[10px] text-muted-foreground">
              剩余 {formatQuotaAmount(remaining, quotaUnit)} {quotaUnit}
              {meta.resetsAt ? ` / ⟳ ${formatResetCountdown(meta.resetsAt)}` : ""}
            </div>
          </div>

          <div
            className="truncate pr-3 tabular-nums text-muted-foreground"
            title={formatDateTime(meta.expiresAt)}
          >
            {formatDateTime(meta.expiresAt)}
          </div>

          <div className="pr-3">
            <span
              className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium ${
                isActive
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {isActive ? "活跃" : "停用"}
            </span>
          </div>

          <div
            className="truncate tabular-nums text-muted-foreground"
            title={
              meta.daysUntilExpiry != null
                ? `${meta.daysUntilExpiry} 天后过期`
                : undefined
            }
          >
            {meta.daysUntilExpiry != null ? `${meta.daysUntilExpiry} 天` : "-"}
          </div>
        </div>
      </div>
    </div>
  );
};

// 单个套餐数据展示组件
const UsagePlanItem: React.FC<{ data: UsageData }> = ({ data }) => {
  const { t } = useTranslation();
  const {
    planName,
    extra,
    isValid,
    invalidMessage,
    total,
    used,
    remaining,
    unit,
  } = data;

  // 判断套餐是否失效（isValid 为 false 或未定义时视为有效）
  const isExpired = isValid === false;

  return (
    <div className="flex items-center gap-3">
      {/* 标题部分：25% */}
      <div
        className="text-xs text-gray-500 dark:text-gray-400 min-w-0"
        style={{ width: "25%" }}
      >
        {planName ? (
          <span
            className={`font-medium truncate block ${isExpired ? "text-red-500 dark:text-red-400" : ""}`}
            title={planName}
          >
            💰 {planName}
          </span>
        ) : (
          <span className="opacity-50">—</span>
        )}
      </div>

      {/* 扩展字段：30% */}
      <div
        className="text-xs text-gray-500 dark:text-gray-400 min-w-0 flex items-center gap-2"
        style={{ width: "30%" }}
      >
        {extra && (
          <span
            className={`truncate ${isExpired ? "text-red-500 dark:text-red-400" : ""}`}
            title={extra}
          >
            {extra}
          </span>
        )}
        {isExpired && (
          <span className="text-red-500 dark:text-red-400 font-medium text-[10px] px-1.5 py-0.5 bg-red-50 dark:bg-red-900/20 rounded flex-shrink-0">
            {invalidMessage || t("usage.invalid")}
          </span>
        )}
      </div>

      {/* 用量信息：45% */}
      <div
        className="flex items-center justify-end gap-2 text-xs flex-shrink-0"
        style={{ width: "45%" }}
      >
        {/* 总额度 */}
        {total !== undefined && (
          <>
            <span className="text-gray-500 dark:text-gray-400">
              {t("usage.total")}
            </span>
            <span className="tabular-nums text-gray-600 dark:text-gray-400">
              {total === -1 ? "∞" : total.toFixed(2)}
            </span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
          </>
        )}

        {/* 已用额度 */}
        {used !== undefined && (
          <>
            <span className="text-gray-500 dark:text-gray-400">
              {t("usage.used")}
            </span>
            <span className="tabular-nums text-gray-600 dark:text-gray-400">
              {used.toFixed(2)}
            </span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
          </>
        )}

        {/* 剩余额度 - 突出显示 */}
        {remaining !== undefined && (
          <>
            <span className="text-gray-500 dark:text-gray-400">
              {t("usage.remaining")}
            </span>
            <span
              className={`font-semibold tabular-nums ${
                isExpired
                  ? "text-red-500 dark:text-red-400"
                  : remaining < (total || remaining) * 0.1
                    ? "text-orange-500 dark:text-orange-400"
                    : "text-green-600 dark:text-green-400"
              }`}
            >
              {remaining.toFixed(2)}
            </span>
          </>
        )}

        {unit && (
          <span className="text-gray-500 dark:text-gray-400">{unit}</span>
        )}
      </div>
    </div>
  );
};

// 格式化相对时间
function formatRelativeTime(
  timestamp: number,
  now: number,
  t: (key: string, options?: { count?: number }) => string,
): string {
  const diff = Math.floor((now - timestamp) / 1000); // 秒

  if (diff < 60) {
    return t("usage.justNow");
  } else if (diff < 3600) {
    const minutes = Math.floor(diff / 60);
    return t("usage.minutesAgo", { count: minutes });
  } else if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return t("usage.hoursAgo", { count: hours });
  } else {
    const days = Math.floor(diff / 86400);
    return t("usage.daysAgo", { count: days });
  }
}

export default UsageFooter;
