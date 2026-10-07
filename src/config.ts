import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少環境變數 ${name}，請先複製 .env.example 為 .env 並填入`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  ownerIds: optional("OWNER_IDS")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
  dataFile: optional("DATA_FILE", "./data/bot.json"),
  /** 每日備份保留幾份，0 表示不備份 */
  dataBackupKeep: Math.max(0, Math.floor(Number(optional("DATA_BACKUP_KEEP", "7")) || 0)),
  sauceNao: {
    apiKey: optional("SAUCENAO_API_KEY"),
    minSimilarity: Number(optional("SAUCENAO_MIN_SIMILARITY", "60")),
  },
  e621: {
    userAgent: optional("E621_USER_AGENT", "MachineChubbyBot/1.0"),
    login: optional("E621_LOGIN"),
    apiKey: optional("E621_API_KEY"),
  },
};
