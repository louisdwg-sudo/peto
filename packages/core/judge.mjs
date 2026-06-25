const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_JUDGE_EFFORT = "low";
const JUDGE_LABELS = ["accepted", "underfit", "overfit", "rejected"];

export async function judgeRoute({ userExcerpt, responseText, chosenEffort, config = {} }) {
  try {
    if (!config.upstreamBaseUrl) throw new Error("judge requires upstreamBaseUrl in config.");
    const raw = await callJudge({ userExcerpt, responseText, chosenEffort, config });
    const parsed = parseJson(raw, "Judge upstream returned non-JSON response.");
    const text = extractResponseTextFromObject(parsed);
    const verdict = parseJudgeVerdict(text);
    return {
      label: verdict.label,
      reason: verdict.reason,
      usage: parsed.usage || parsed.response?.usage || null,
      error: null,
    };
  } catch (error) {
    return {
      label: "ambiguous",
      reason: null,
      usage: null,
      error: error.message,
    };
  }
}

async function callJudge({ userExcerpt, responseText, chosenEffort, config }) {
  const response = await fetch(new URL("/v1/responses", config.upstreamBaseUrl), {
    method: "POST",
    headers: upstreamHeaders(config),
    body: JSON.stringify({
      model: config.judgeModel || DEFAULT_JUDGE_MODEL,
      input: buildJudgePrompt({ userExcerpt, responseText, chosenEffort }),
      reasoning: { effort: config.judgeEffort || DEFAULT_JUDGE_EFFORT },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Judge call failed with ${response.status}: ${raw.slice(0, 500)}`);
  return raw;
}

function buildJudgePrompt({ userExcerpt, responseText, chosenEffort }) {
  return [
    "You are evaluating whether the effort level chosen by a router was appropriate.",
    `Request: ${userExcerpt || ""}`,
    `Effort chosen: ${chosenEffort || ""}`,
    `Response: ${responseText || ""}`,
    "",
    "Was the effort appropriate?",
    "- accepted: response satisfied the request at this effort level",
    "- underfit: response was too shallow; higher effort was needed",
    "- overfit: response was verbose/excessive; lower effort would have sufficed",
    "- rejected: response was incorrect or unusable",
    "",
    'Return only JSON: {"label":"accepted|underfit|overfit|rejected","reason":"one sentence"}',
  ].join("\n");
}

function upstreamHeaders(config) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(config.upstreamHeaders || {}),
  };
  const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === "authorization");
  const token = config.upstreamApiKey || config.apiKey || config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (token && !hasAuthorization) headers.authorization = `Bearer ${token}`;
  return headers;
}

function parseJudgeVerdict(text) {
  const parsed = parseJson(text, "Judge returned unparseable JSON.");
  const label = String(parsed.label || "").toLowerCase();
  if (!JUDGE_LABELS.includes(label)) throw new Error("Judge returned unparseable JSON.");
  return {
    label,
    reason: parsed.reason ? String(parsed.reason).slice(0, 500) : null,
  };
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

function extractResponseTextFromObject(parsed) {
  if (typeof parsed.output_text === "string") return parsed.output_text;
  const outputText = parsed.output
    ?.flatMap(item => item.content || [])
    .map(content => content.text)
    .filter(Boolean)
    .join("\n");
  if (outputText) return outputText;
  throw new Error("Judge returned no text content.");
}
