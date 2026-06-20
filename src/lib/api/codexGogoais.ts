import { invoke } from "@tauri-apps/api/core";

export interface CodexGogoaisLoginInput {
  account: string;
  password: string;
  loginBaseUrl?: string;
  codeBaseUrl?: string;
}

export interface CodexGogoaisLoginResult {
  apiKey: string;
  baseUrl: string;
  loginBaseUrl: string;
}

export const codexGogoaisApi = {
  async login(
    input: CodexGogoaisLoginInput,
  ): Promise<CodexGogoaisLoginResult> {
    return await invoke("codex_gogoais_login", { input });
  },
};
