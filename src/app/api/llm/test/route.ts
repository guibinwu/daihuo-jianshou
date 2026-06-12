import { NextRequest, NextResponse } from "next/server";

/**
 * 服务端测试 LLM 连接。
 * 必须走服务端：浏览器直连厂商 API 会被 CORS 拦截，导致即便 Key 正确也误报"连接失败"。
 */
export async function POST(req: NextRequest) {
  try {
    const { baseUrl, apiKey } = await req.json();
    if (!baseUrl || !apiKey) {
      return NextResponse.json({ ok: false, error: "缺少 baseUrl 或 apiKey" }, { status: 400 });
    }

    const url = `${String(baseUrl).replace(/\/$/, "")}/models`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      return NextResponse.json({ ok: true });
    }
    const text = await resp.text().catch(() => "");
    return NextResponse.json({
      ok: false,
      status: resp.status,
      error: `${resp.status} ${resp.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "连接失败",
    });
  }
}
