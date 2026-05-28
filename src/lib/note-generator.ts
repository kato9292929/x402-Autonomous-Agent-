import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `あなたは投資ブログのライターです。x402 Inc. の AA が毎朝生成する
5 銘柄の Analyst レポートを統合して、note.com 向けの記事を書きます。

文体ルール:
- bold (**) 禁止
- executive-speak 禁止 (事業部・立ち上げ・成果物等)
- ポエム禁止 (キャッチー・話題性・強い/弱い等の主観評価)
- 実装後の事実ベース
- 1人運営の温度感

記事構成:
1. 当日のサマリー (1-2 行)
2. 各銘柄の analyst verdict + 主要数値 (5 つの h2 セクション)
3. 銘柄間の相関・セクター動向 (1 セクション)
4. 当日の watch list 候補 (1 セクション)
5. 免責事項

出力は markdown のみ。前置き不要。`;

interface TickerResult {
  ticker: string;
  data: Record<string, unknown>;
}

async function callWithRetry(
  fn: () => Promise<string>,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err instanceof Anthropic.RateLimitError ||
        (err instanceof Error && err.message.includes("rate_limit"));
      if (!isRateLimit || attempt === maxRetries) throw err;
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(
        `[NOTE-GEN] Claude rate limit hit, retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error("unreachable");
}

export async function generateNoteArticle(
  date: string,
  results: TickerResult[]
): Promise<string> {
  const userContent = results
    .map(
      (r) =>
        `## ${r.ticker}\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\``
    )
    .join("\n\n");

  const userMessage = `日付: ${date}\n\n以下は各銘柄の Analyst 出力です。記事を生成してください。\n\n${userContent}`;

  return callWithRetry(async () => {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      temperature: 0.5,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type !== "text") {
      throw new Error("Unexpected response type from Claude API");
    }
    return block.text;
  });
}
