export default {
  id: "commandcode",
  priority: 100,
  alias: "commandcode",
  aliases: [
    "cmc",
  ],
  uiAlias: "cmc",
  display: {
    name: "Command Code",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "CC",
    website: "https://commandcode.ai",
    notice: {
      text: "Use your CommandCode CLI API key (starts with user_...) from ~/.commandcode/auth.json or commandcode.ai/studio.",
      apiKeyUrl: "https://commandcode.ai/studio",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.commandcode.ai/alpha/generate",
    format: "commandcode",
    forceStream: true,
    // Fail fast on a stuck connect. Measured: upstream always returns response
    // headers in <1s even for a 160k-token prompt, so 15s is generous headroom.
    // The 60s default multiplies badly because base.js retries connect failures
    // with the 502 config (3 attempts) -> worst case 4*60s + 3*3s = 249s before
    // the caller sees an error. At 15s that drops to 4*15s + 9s = 69s.
    timeoutMs: 15000,
    headers: {
      "x-command-code-version": "1.53.0",
      "x-cli-environment": "cli",
    },
  },
  models: [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000 },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1000000 },
    { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
    { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code HighSpeed" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
    { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5" },
    { id: "zai-org/GLM-5.2", name: "GLM 5.2" },
    { id: "zai-org/GLM-5.2-Fast", name: "GLM 5.2 Fast" },
    { id: "zai-org/GLM-5.1", name: "GLM 5.1" },
    { id: "zai-org/GLM-5", name: "GLM 5" },
    { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "xiaomi/mimo-v2.5", name: "MiMo V2.5" },
    { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview" },
    { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus" },
    { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max" },
    { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus" },
    { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash" },
    { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
