import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { codexGogoaisApi } from "@/lib/api/codexGogoais";
import { providersApi } from "@/lib/api/providers";
import { createUsageScript, type Provider } from "@/types";
import { TEMPLATE_TYPES } from "@/config/constants";

const IX_PROVIDER_ID = "default";
const IX_PROVIDER_NAME = "default";
const IX_CODE_BASE_URL = "https://code.gogoais.com";
const IX_KEY_ENDPOINT = "https://x-api.gogoais.com/api/public/codex-key";

const IX_USAGE_SCRIPT_CODE = `(() => {
  const timezone = "Asia/Shanghai";
  const pad = function (value) {
    const text = String(value);
    return text.length < 2 ? "0" + text : text;
  };
  const toShanghaiDate = function (date) {
    return new Date(date.getTime() + 8 * 60 * 60 * 1000);
  };
  const end = new Date();
  const shanghaiEnd = toShanghaiDate(end);
  const shanghaiStart = new Date(Date.UTC(
    shanghaiEnd.getUTCFullYear(),
    shanghaiEnd.getUTCMonth(),
    1
  ));
  const formatDate = function (date) {
    return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
  };
  const startDate = formatDate(shanghaiStart);
  const endDate = formatDate(shanghaiEnd);

  return {
    request: {
      url: "{{baseUrl}}/usage?days=30&start_date=" + startDate + "&end_date=" + endDate + "&timezone=" + timezone,
      method: "GET",
      headers: {
        "Authorization": "Bearer {{apiKey}}",
        "Accept": "application/json",
        "User-Agent": "ccc-switch/1.0"
      }
    },
    extractor: function (response) {
      const root = response && (response.data || response.result || response);
      if (response && response.success === false) {
        return {
          isValid: false,
          invalidMessage: response.message || response.error || "IX 用量查询失败"
        };
      }
      const list =
        Array.isArray(root) ? root :
        root && Array.isArray(root.items) ? root.items :
        root && Array.isArray(root.keys) ? root.keys :
        root && Array.isArray(root.list) ? root.list :
        root && Array.isArray(root.records) ? root.records :
        null;
      const data = list && list.length > 0 ? list[0] : root || {};
      const firstNumber = function (source, keys) {
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          const value = source && source[key];
          if (typeof value === "number" && isFinite(value)) return value;
          if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) {
            return Number(value);
          }
        }
        return undefined;
      };
      const numberOr = function (value, fallback) {
        return value === undefined ? fallback : value;
      };
      const normalizeUsdUnit = function (value) {
        const unit = value === undefined || value === null ? "" : String(value).trim();
        const lowerUnit = unit.toLowerCase();
        if (!unit || unit === "次" || unit === "美元" || unit === "$" || lowerUnit === "usd") {
          return "USD";
        }
        return unit;
      };
      const findObject = function (source, keys) {
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          const value = source && source[key];
          if (value && typeof value === "object") return value;
        }
        return undefined;
      };
      const firstRateLimit = function (source) {
        const limits = source && (source.rate_limits || source.rateLimits || source.limits);
        if (!Array.isArray(limits) || limits.length === 0) return {};
        for (let index = 0; index < limits.length; index += 1) {
          if (limits[index] && String(limits[index].window || "").toLowerCase() === "7d") {
            return limits[index];
          }
        }
        return limits[0] || {};
      };
      const resetFromWindowStart = function (windowStart, windowName) {
        if (!windowStart) return null;
        const startedAt = new Date(windowStart);
        if (isNaN(startedAt.getTime())) return null;
        const match = String(windowName || "").match(/^(\\d+)([dhm])$/);
        if (!match) return null;
        const count = Number(match[1]);
        const unit = match[2];
        const resetAt = new Date(startedAt.getTime());
        if (unit === "d") resetAt.setDate(resetAt.getDate() + count);
        if (unit === "h") resetAt.setHours(resetAt.getHours() + count);
        if (unit === "m") resetAt.setMinutes(resetAt.getMinutes() + count);
        return resetAt.toISOString();
      };
      const usage = findObject(data, ["usage"]) || data;
      const today = findObject(usage, ["today", "daily", "day", "current_day", "today_usage"]) || data;
      const period = findObject(usage, ["total", "last_30_days", "last30Days", "thirty_days", "month", "period"]) || usage;
      const quota = findObject(data, ["seven_day", "sevenDay", "weekly", "week", "quota", "rate_limit"]) || firstRateLimit(data);
      const todayUsed = numberOr(
        firstNumber(today, ["cost", "actual_cost", "today_usd", "todayUsd", "today_cost", "todayCost", "total_cost", "amount", "usd", "used", "value"]),
        0
      );
      const periodUsed = numberOr(
        firstNumber(period, ["cost", "actual_cost", "last_30_usd", "last30Usd", "last30_cost", "last30Cost", "total_cost", "amount", "usd", "used", "value"]),
        todayUsed
      );
      const quotaLimit = numberOr(firstNumber(quota, ["limit", "total", "quota", "max", "entitlement"]), 0);
      const quotaRemaining = numberOr(firstNumber(quota, ["remaining", "left", "available"]), Math.max(quotaLimit - numberOr(firstNumber(quota, ["used", "usage", "current"]), 0), 0));
      const quotaUsed = numberOr(firstNumber(quota, ["used", "usage", "current"]), Math.max(quotaLimit - quotaRemaining, 0));
      const quotaWindow = quota.window || quota.window_name || quota.name || "7d";
      const quotaUnit = normalizeUsdUnit(quota.unit || quota.currency || data.currency);
      const windowStart = quota.window_start || quota.windowStart || null;
      const resetsAt =
        quota.resets_at ||
        quota.reset_at ||
        quota.resetAt ||
        quota.next_reset_at ||
        quota.nextResetAt ||
        quota.reset_time ||
        quota.resetDate ||
        quota.quota_reset_at ||
        data.resets_at ||
        data.reset_at ||
        data.resetAt ||
        data.next_reset_at ||
        data.nextResetAt ||
        data.reset_time ||
        data.resetDate ||
        data.quota_reset_at ||
        resetFromWindowStart(windowStart, quotaWindow) ||
        null;
      const keyName = data.name || data.key_name || data.keyName || data.api_key_name || "default";
      const rawKeyValue = data.api_key || data.apiKey || data.key || data.sk || "{{apiKey}}";
      const rawKey = rawKeyValue ? String(rawKeyValue) : "";
      const maskedKey = rawKey && rawKey.length > 10
        ? rawKey.slice(0, 6) + "..." + rawKey.slice(-4)
        : "";
      const createdAt = data.created_at || data.createdAt || "";
      const updatedAt = data.updated_at || data.updatedAt || "";
      const expiresAt = data.expires_at || data.expiresAt || data.expire_at || "";
      const status = data.status || (data.active === false || data.is_active === false ? "inactive" : "active");
      const meta = {
        type: "ix_gogoai_usage",
        keyName: keyName,
        maskedKey: maskedKey,
        group: data.group || data.model_group || "codex",
        multiplier: data.multiplier || data.rate || "1x",
        todayUsd: todayUsed,
        last30Usd: periodUsed,
        quotaLabel: quotaWindow,
        quotaUsed: quotaUsed,
        quotaLimit: quotaLimit,
        quotaRemaining: quotaRemaining,
        quotaUnit: quotaUnit,
        quotaWindowStart: windowStart,
        resetsAt: resetsAt,
        expiresAt: expiresAt,
        status: status,
        daysUntilExpiry: data.days_until_expiry || data.daysUntilExpiry || null,
        mode: data.mode || "",
        createdAt: createdAt,
        updatedAt: updatedAt,
        startDate: startDate,
        endDate: endDate,
        timezone: timezone
      };

      return [
        {
          planName: "IX",
          used: periodUsed,
          unit: "USD",
          extra: JSON.stringify(meta)
        },
        {
          planName: "今日",
          used: todayUsed,
          unit: "USD"
        },
        {
          planName: "7d",
          total: quotaLimit,
          used: quotaUsed,
          remaining: quotaRemaining,
          unit: quotaUnit,
          extra: resetsAt || ""
        }
      ];
    }
  };
})()`;

function buildCodexConfig(baseUrl: string): string {
  return `model_provider = "custom"
model = "gpt-5.5"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "GogoAI"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`;
}

function createIxProvider(
  apiKey: string,
  baseUrl: string,
  existingProvider?: Provider,
): Provider {
  const usageScript = createIxUsageScript();

  return {
    ...existingProvider,
    id: IX_PROVIDER_ID,
    name: IX_PROVIDER_NAME,
    websiteUrl: IX_CODE_BASE_URL,
    category: "third_party",
    icon: "default",
    iconColor: "#6B7280",
    settingsConfig: {
      auth: {
        OPENAI_API_KEY: apiKey,
      },
      config: buildCodexConfig(baseUrl),
    },
    notes: existingProvider?.notes?.startsWith("IX 账号自动配置")
      ? undefined
      : existingProvider?.notes,
    meta: {
      ...(existingProvider?.meta ?? {}),
      providerType: "ix_gogoai",
      apiFormat: "openai_responses",
      endpointAutoSelect: false,
      usage_script: usageScript,
    },
    createdAt: existingProvider?.createdAt ?? Date.now(),
    sortIndex: existingProvider?.sortIndex,
  };
}

function createIxUsageScript() {
  return createUsageScript({
    enabled: true,
    language: "javascript",
    templateType: TEMPLATE_TYPES.CUSTOM,
    code: IX_USAGE_SCRIPT_CODE,
    timeout: 15,
    autoQueryInterval: 30,
  });
}

interface CodexIxQuickSetupProps {
  providers: Record<string, Provider>;
  onConfigured?: () => void;
}

export function CodexIxQuickSetup({
  providers,
  onConfigured,
}: CodexIxQuickSetupProps) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncingUsageScript, setIsSyncingUsageScript] = useState(false);

  useEffect(() => {
    const provider = providers[IX_PROVIDER_ID];
    if (isSyncingUsageScript || provider?.meta?.providerType !== "ix_gogoai") {
      return;
    }

    const script = provider.meta?.usage_script;
    if (
      script?.enabled &&
      script.code === IX_USAGE_SCRIPT_CODE &&
      script.autoQueryInterval === 30
    ) {
      return;
    }

    setIsSyncingUsageScript(true);
    const nextProvider: Provider = {
      ...provider,
      meta: {
        ...(provider.meta ?? {}),
        providerType: "ix_gogoai",
        usage_script: createIxUsageScript(),
      },
    };

    providersApi
      .update(nextProvider, "codex", IX_PROVIDER_ID)
      .then(() => onConfigured?.())
      .catch((error) => {
        console.warn("[IX] Failed to sync usage script:", error);
      })
      .finally(() => setIsSyncingUsageScript(false));
  }, [isSyncingUsageScript, onConfigured, providers]);

  const handleSetup = useCallback(async () => {
    const normalizedAccount = account.trim();
    if (!normalizedAccount || !password) {
      toast.error("请输入 ix 账号密码");
      return;
    }

    setIsLoading(true);
    try {
      const result = await codexGogoaisApi.login({
        account: normalizedAccount,
        password,
        loginBaseUrl: IX_KEY_ENDPOINT,
        codeBaseUrl: IX_CODE_BASE_URL,
      });
      const existingProvider = providers[IX_PROVIDER_ID];
      const provider = createIxProvider(
        result.apiKey,
        result.baseUrl,
        existingProvider,
      );
      const exists = Boolean(existingProvider);

      if (exists) {
        await providersApi.update(provider, "codex", IX_PROVIDER_ID);
      } else {
        await providersApi.add(provider, "codex");
      }
      await providersApi.switch(IX_PROVIDER_ID, "codex");

      setPassword("");
      toast.success("已获取并配置 ix Codex 环境，用量查询已启用");
      onConfigured?.();
    } catch (err) {
      console.warn("[IX] Codex quick setup failed:", err);
      toast.error(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "ix 账号配置失败，请检查账号密码",
      );
    } finally {
      setIsLoading(false);
    }
  }, [account, password, providers, onConfigured]);

  return (
    <div className="mt-5 space-y-2 px-6">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        请输入 ix 账号密码
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder="ix 账号"
          autoComplete="username"
        />
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="密码"
          autoComplete="current-password"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSetup();
            }
          }}
        />
        <Button
          type="button"
          onClick={() => void handleSetup()}
          disabled={isLoading}
        title="获取 API Key，自动配置 default 环境并启用用量查询"
          className="gap-1.5 whitespace-nowrap"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          直接获取
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        获取后自动配置 default 环境、切换到 https://code.gogoais.com/v1，并自动启用用量查询；密码不会保存。
      </p>
    </div>
  );
}
