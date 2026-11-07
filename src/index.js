/**
 * Cloudflare Worker — OpenAI を呼ぶ API ルート
 *
 * ルーティング:
 *   /api/*  → この Worker が処理
 *   それ以外 → public/ の静的アセット(Worker は起動しない = 無料・無制限)
 */

// ── 使うモデル(ここだけ変えれば全体に効く) ────────────────
//   gpt-6-luna    $0.10/$0.50 per MTok  最安・高速。まずはこれ
//   gpt-6.1-terra $1/$5                 中位
//   gpt-6.1-sol   $2/$10                高性能
//   gpt-6-astra   $10/$50               フラッグシップ
const DEFAULT_MODEL = "gpt-6-luna";

const OPENAI_URL = "https://api.openai.com/v1/responses";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/chat") return handleChat(request, env);
    if (pathname === "/api/guess") return handleGuess(request, env);

    if (pathname.startsWith("/api/")) {
      return json({ error: "Not found", path: pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

/**
 * キーの取り違えは当日いちばん時間を溶かすので、
 * OpenAI に投げる前に形式だけ検査して具体的な指示を返す。
 * 値そのものはレスポンスに含めない。
 */
function readApiKey(env) {
  const raw = env.OPENAI_API_KEY;
  if (!raw) {
    return {
      error: "OPENAI_API_KEY が設定されていません",
      hint: "ローカル: .dev.vars に記載 / 本番: npx wrangler secret put OPENAI_API_KEY",
    };
  }

  // 前後の空白と、囲みクォートを除去
  const key = String(raw).trim().replace(/^(['"])(.*)\1$/s, "$2").trim();

  if (!key) {
    return { error: "OPENAI_API_KEY が空です" };
  }
  if (/^sk-sk-/.test(key)) {
    return {
      error: "OPENAI_API_KEY の先頭が sk- で重複しています",
      hint: ".dev.vars のプレースホルダの後ろに貼り付けていませんか。= の右側すべてを置き換えてください",
    };
  }
  if (!/^sk-/.test(key)) {
    return {
      error: "OPENAI_API_KEY が sk- で始まっていません",
      hint: "キー全体が貼られているか、余計な文字が混ざっていないか確認してください",
    };
  }
  if (/\s/.test(key)) {
    return {
      error: "OPENAI_API_KEY に空白や改行が含まれています",
      hint: "折り返してコピーされた可能性があります。1行で貼り直してください",
    };
  }

  return { key };
}

async function handleChat(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ error: "POST のみ対応しています" }, 405);
  }

  const auth = readApiKey(env);
  if (auth.error) return json(auth, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエストボディが JSON として解釈できません" }, 400);
  }

  // input は文字列でも配列でも可
  //   "こんにちは"
  //   [{ role: "user", content: "こんにちは" }]
  const input = body.input ?? body.messages;
  if (!input) {
    return json({ error: "input が必要です" }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: body.model ?? DEFAULT_MODEL,
        input,
        stream: true,
        ...(body.instructions ? { instructions: body.instructions } : {}),
      }),
    });
  } catch (e) {
    return json({ error: "OpenAI に接続できませんでした", detail: String(e) }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return json(
      {
        error: "OpenAI API がエラーを返しました",
        status: upstream.status,
        detail: detail.slice(0, 1000),
      },
      upstream.status,
    );
  }

  // ── ここが肝 ──────────────────────────────────────────
  // SSE をパースせず、ストリームをそのまま流す。
  // チャンクごとに処理しないので CPU 時間をほぼ消費しない。
  // (無料プランは 1リクエスト 10ms CPU。待ち時間は計上されない)
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      ...corsHeaders(),
    },
  });
}


/* ──────────────────────────────────────────────────────────
 * /api/guess — 「化かし合い」の AI 側
 *
 * 設計上の約束: ここは絶対に落ちない。
 *   OpenAI が死んでも、鍵が無くても、JSON が壊れても、
 *   必ず候補の中から 1つ以上を返す。ゲームが止まる方が事故。
 * ────────────────────────────────────────────────────────── */
async function handleGuess(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") return json({ error: "POST のみ対応しています" }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエストボディが JSON として解釈できません" }, 400);
  }

  const candidates = Array.isArray(body.candidates) ? body.candidates.filter((c) => typeof c === "string") : [];
  const grid = Array.isArray(body.grid) ? body.grid.map(String) : [];
  const want = Math.max(1, Math.min(3, Number(body.count) || 1));
  if (!candidates.length) return json({ error: "candidates が必要です" }, 400);

  /* force が来たら、その字を名指ししたことにして理由だけ書かせる。
     当てた字と噛み合わない読み筋が出ると嘘が見えるので、理由も合わせる。 */
  const force = typeof body.force === "string" && candidates.includes(body.force) ? body.force : null;

  // 何があってもこれを返せる
  const fallback = (why) => json({
    guesses: force ? [force] : pickRandom(candidates, want),
    reason: "勘で言う。これだ。",
    fallback: true,
    ...(why ? { note: why } : {}),
  });

  const auth = readApiKey(env);
  if (auth.error) return fallback(auth.error);

  const prompt = force ? [
    "これは漢字の化かし合いだ。相手は漢字1文字に化けて隠れている。",
    "相手は好きな場所に丸い窓を開けて、自分の画をそこだけ見せる。",
    "",
    "見せられた画 (■=そこに画があると示された / ・=何も示されていない):",
    ...grid,
    "",
    `お前は相手の正体を <${force}> だと見抜いた。断定しろ。迷うな。`,
    "見えている断片のどこがその根拠になったのかを、短く言い切れ。",
    "",
    "出力は JSON のみ。説明文や ``` は付けるな。",
    `{"guesses":["${force}"],"reason":"30字以内"}`,
    "reason は短く断定的に、芝居がかった口調で。",
  ].join("\n") : [
    "これは漢字の化かし合いだ。相手は漢字1文字に化けて隠れている。",
    "相手は好きな場所に丸い窓を開けて、自分の画をそこだけ見せる。",
    "",
    "見せられた画 (■=そこに画があると示された / ・=何も示されていない):",
    ...grid,
    "",
    "・ は「画が無い」ではない。ただ見せられていないだけで、そこに画がある可能性は残る。",
    "この図は見せられた画を囲む範囲だけを切り出したものだ。",
    "字全体のどのあたりかは分からない。上下左右の端がどこかも分からない。",
    "断片どうしの位置関係と形だけが手がかりだ。",
    "",
    `開けられた窓の数: ${Number(body.revealed) || 0}`,
    body.partial
      ? `まだあり得る漢字は全部で ${Number(body.totalCandidates) || candidates.length} 字ある。そのうち ${candidates.length} 字を抜き出したものがこれだ:\n${candidates.join(" ")}\n相手は必ずこの中にいる。`
      : `まだあり得る漢字 (${candidates.length}字): ${candidates.join(" ")}`,
    "",
    "相手は「正体が割れにくい場所」を選んで開けている。",
    "見えている形と、断片どうしの並びから読め。相手の選び方の癖を疑え。",
    "",
    "出力は JSON のみ。説明文や ``` は付けるな。",
    `{"guesses":[${Array(want).fill('"漢字"').join(",")}],"reason":"30字以内"}`,
    `guesses は上の候補から必ず ${want} 個、重複なし。reason は短く断定的に、芝居がかった口調で。`,
  ].join("\n");

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: body.model ?? DEFAULT_MODEL,
        input: prompt,
        reasoning: { effort: body.effort ?? "none" },
      }),
    });
  } catch (e) {
    return fallback(`fetch 失敗: ${String(e)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return fallback(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
  }

  let text = "";
  try {
    text = extractText(await res.json());
  } catch (e) {
    return fallback(`レスポンス解析失敗: ${String(e)}`);
  }

  const parsed = parseLoose(text);
  let guesses = force
    ? [force]
    : (Array.isArray(parsed?.guesses) ? parsed.guesses.filter((g) => candidates.includes(g)) : []);
  guesses = [...new Set(guesses)].slice(0, want);
  // 足りない分は候補から補う(モデルが候補外を言ってきた場合など)
  for (const c of shuffle(candidates)) {
    if (guesses.length >= want) break;
    if (!guesses.includes(c)) guesses.push(c);
  }
  if (!guesses.length) return fallback("候補に合致する guesses が無い");

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 60)
    : "読めた。";

  return json({ guesses, reason, raw: text.slice(0, 200) });
}

/** Responses API のレスポンスから本文を拾う(形が変わっても耐える) */
function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  const chunks = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.text === "string" && (node.type === "output_text" || node.type === "text")) {
      chunks.push(node.text);
    }
    Object.values(node).forEach(walk);
  };
  walk(data?.output ?? data);
  return chunks.join("");
}

/** ```json で囲まれていても最初の { から最後の } を拾って読む */
function parseLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, n) {
  return shuffle(arr).slice(0, Math.min(n, arr.length));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
