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
