import { useCallback, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { codexGogoaisApi } from "@/lib/api/codexGogoais";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";

const IX_PROVIDER_ID = "default";
const IX_PROVIDER_NAME = "default";
const IX_CODE_BASE_URL = "https://code.gogoais.com";
const IX_LOGIN_BASE_URL = "https://totp.gogoais.com/api";

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
    notes: "IX 账号自动配置",
    meta: {
      apiFormat: "openai_responses",
      endpointAutoSelect: false,
    },
    createdAt: existingProvider?.createdAt ?? Date.now(),
    sortIndex: existingProvider?.sortIndex,
  };
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
        loginBaseUrl: IX_LOGIN_BASE_URL,
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
      toast.success("已获取并配置 ix Codex 环境");
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
          title="获取 API Key 并自动配置 default 环境"
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
        获取后自动配置 default 环境并切换到 https://code.gogoais.com/v1，密码不会保存。
      </p>
    </div>
  );
}
