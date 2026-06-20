"use client";

/**
 * 新版「先做后配」落地页（暗色创作台方向）。
 * 作为新路由 /start 独立存在，不动正在被 i18n 改写的首页；落地即操作：
 * 上传商品图 或 一句话成片 → 直接开跑，要用到 AI 才提示配 Key（推荐 Atlas 一键）。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { exampleProducts, type ExampleProduct } from "@/lib/examples";

type Mode = "upload" | "topic";
interface PickedImage {
  id: string;
  url: string;
  file: File;
}
interface RecentProject {
  id: string;
  name: string;
  productName: string | null;
  status: string;
  updatedAt: string | null;
}

export default function StartPage() {
  const router = useRouter();
  const { llm } = useSettingsStore();
  const llmReady = llm.apiKey.trim().length > 0;

  const [mode, setMode] = useState<Mode>("upload");
  const [images, setImages] = useState<PickedImage[]>([]);
  const [productName, setProductName] = useState("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [topic, setTopic] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // 拉最近项目，给回头客一个「继续」入口（替代旧首页的项目列表，避免被孤立）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/project");
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setRecent(Array.isArray(data) ? data.slice(0, 4) : []);
      } catch {
        /* 忽略 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 按项目状态跳到合适的步骤
  const stepFor = (status: string) =>
    status === "done" || status === "composing" || status === "video" ? "video" : status === "assets" ? "assets" : "script";

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    setImages((prev) => {
      const remaining = 5 - prev.length;
      if (remaining <= 0) return prev;
      const next = Array.from(files)
        .slice(0, remaining)
        .filter((f) => f.type.startsWith("image/"))
        .map((file) => ({ id: crypto.randomUUID(), url: URL.createObjectURL(file), file }));
      return [...prev, ...next];
    });
  }, []);

  const removeImage = (id: string) =>
    setImages((prev) => {
      const t = prev.find((i) => i.id === id);
      if (t) URL.revokeObjectURL(t.url);
      return prev.filter((i) => i.id !== id);
    });

  // 一键填示例：拉示例图为 File 落进上传区 + 填好名称/卖点
  const fillExample = useCallback(async (ex: ExampleProduct) => {
    setMode("upload");
    setProductName(ex.name);
    setSellingPoints(ex.sellingPoints);
    try {
      const res = await fetch(ex.image);
      const blob = await res.blob();
      const file = new File([blob], `${ex.id}.png`, { type: blob.type || "image/png" });
      setImages((prev) => {
        prev.forEach((i) => URL.revokeObjectURL(i.url));
        return [{ id: crypto.randomUUID(), url: URL.createObjectURL(file), file }];
      });
    } catch {
      /* 取图失败也无妨，文字已填好 */
    }
  }, []);

  const canStart =
    mode === "topic" ? topic.trim().length >= 2 : images.length >= 1 && productName.trim().length > 0;

  const llmConfig = () => ({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, visionModel: llm.visionModel });

  const startTopic = async () => {
    const res = await fetch("/api/topic/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: topic.trim(), narrationStyle: "knowledge", targetDuration: 25, llmConfig: llmConfig() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.projectId) throw new Error(data.error || "生成失败，请检查 LLM 配置");
    router.push(`/project/${data.projectId}/script`);
  };

  const startUpload = async () => {
    setStage("创建项目…");
    const projectRes = await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${productName} 推广`, productName, productCategory: "other", productDescription: sellingPoints, productImages: [] }),
    });
    if (!projectRes.ok) throw new Error("项目创建失败，请重试");
    const project = await projectRes.json();

    setStage("上传商品图…");
    const fd = new FormData();
    images.forEach((i) => fd.append("files", i.file));
    fd.append("projectId", project.id);
    const uploadRes = await fetch("/api/upload", { method: "POST", body: fd });
    if (!uploadRes.ok) throw new Error("图片上传失败，请检查网络");
    const { paths } = await uploadRes.json();
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productImages: paths }),
    });

    setStage("AI 写脚本…");
    const scriptRes = await fetch("/api/llm/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        productName,
        category: "other",
        productDescription: sellingPoints,
        targetDuration: 30,
        styleType: "auto",
        videoMode: "product_closeup",
        productImages: paths,
        llmConfig: llmConfig(),
      }),
    });
    if (!scriptRes.ok) throw new Error("脚本生成失败，请检查 LLM 配置");
    router.push(`/project/${project.id}/script`);
  };

  const onStart = async () => {
    if (!canStart || busy) return;
    if (!llmReady) {
      setNeedKey(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "topic") await startTopic();
      else await startUpload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "出错了，请重试");
      setBusy(false);
      setStage("");
    }
  };

  return (
    <div className="cf-root">
      <style>{`
        .cf-root{--teal:#5EEAD4;--ink:#04221E;--text:#EDEFF4;--dim:#98A2B3;--muted:#5A6473;--surface:rgba(255,255,255,.035);--surface2:rgba(255,255,255,.06);--bd:rgba(255,255,255,.08);--bd2:rgba(255,255,255,.14);
          min-height:100vh;background:#0B0D12;color:var(--text);position:relative;overflow-x:hidden;
          font-family:ui-sans-serif,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;}
        .cf-amb{position:absolute;inset:0;pointer-events:none;background:radial-gradient(900px 420px at 50% -8%,rgba(94,234,212,.10),transparent 70%),radial-gradient(700px 500px at 85% 0%,rgba(124,92,255,.07),transparent 65%);}
        .cf-grid{position:absolute;inset:0;pointer-events:none;opacity:.5;background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(circle at 50% 22%,#000,transparent 72%);mask-image:radial-gradient(circle at 50% 22%,#000,transparent 72%);}
        .cf-wrap{position:relative;max-width:980px;margin:0 auto;padding:0 24px}
        .cf-nav{display:flex;align-items:center;justify-content:space-between;height:72px}
        .cf-brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:18px;letter-spacing:-.01em}
        .cf-mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--teal),#6CA8FF);display:grid;place-items:center;box-shadow:0 0 22px -6px rgba(94,234,212,.5)}
        .cf-gear{width:34px;height:34px;border-radius:999px;border:1px solid var(--bd);background:var(--surface);color:var(--dim);display:grid;place-items:center;transition:.18s}
        .cf-gear:hover{color:var(--text);border-color:var(--bd2)}
        .cf-hero{padding:46px 0 36px;text-align:center}
        .cf-eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--teal);opacity:.85;margin-bottom:18px}
        .cf-h1{font-weight:700;font-size:clamp(34px,5.6vw,60px);line-height:1.04;letter-spacing:-.02em;margin-bottom:16px}
        .cf-h1 .hl{color:var(--teal);text-shadow:0 0 34px rgba(94,234,212,.35)}
        .cf-sub{color:var(--dim);font-size:16px;line-height:1.7;max-width:560px;margin:0 auto 34px}
        .cf-card{max-width:620px;margin:0 auto;background:var(--surface);border:1px solid var(--bd);border-radius:20px;padding:14px;backdrop-filter:blur(14px);box-shadow:0 30px 80px -40px rgba(0,0,0,.8);text-align:left}
        .cf-tabs{display:flex;gap:6px;background:rgba(0,0,0,.25);border-radius:13px;padding:5px;margin-bottom:14px}
        .cf-tab{flex:1;height:40px;border:0;border-radius:9px;background:transparent;color:var(--dim);font:inherit;font-size:14px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:.18s}
        .cf-tab.on{background:var(--surface2);color:var(--text);box-shadow:inset 0 0 0 1px var(--bd2)}
        .cf-drop{position:relative;border:1.5px dashed rgba(94,234,212,.40);border-radius:14px;background:radial-gradient(420px 160px at 50% 30%,rgba(94,234,212,.16),transparent 70%);padding:34px 24px 26px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;animation:cfBreathe 4.6s ease-in-out infinite;transition:border-color .18s}
        .cf-drop.drag{border-color:var(--teal)}
        @keyframes cfBreathe{0%,100%{box-shadow:0 0 46px -16px rgba(94,234,212,.30)}50%{box-shadow:0 0 78px -14px rgba(94,234,212,.5)}}
        .cf-dic{width:50px;height:50px;border-radius:16px;background:var(--surface2);border:1px solid var(--bd2);display:grid;place-items:center;color:var(--teal);margin-bottom:6px}
        .cf-dt{font-size:16px;font-weight:500}
        .cf-ds{font-size:13px;color:var(--muted)}
        .cf-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
        .cf-thumb{position:relative;width:62px;height:62px;border-radius:10px;overflow:hidden;border:1px solid var(--bd2)}
        .cf-thumb img{width:100%;height:100%;object-fit:cover}
        .cf-thumb button{position:absolute;top:2px;right:2px;width:18px;height:18px;border:0;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;font-size:12px;line-height:1;display:grid;place-items:center}
        .cf-field{margin-top:12px}
        .cf-input,.cf-area{width:100%;background:rgba(0,0,0,.25);border:1px solid var(--bd);border-radius:11px;color:var(--text);font:inherit;font-size:14px;padding:11px 13px;outline:none;transition:.18s}
        .cf-input:focus,.cf-area:focus{border-color:rgba(94,234,212,.45)}
        .cf-area{resize:none;min-height:84px;line-height:1.6}
        .cf-cta-row{display:flex;align-items:center;gap:14px;margin-top:14px;padding:2px 2px 2px}
        .cf-cta{height:48px;padding:0 24px;border:0;border-radius:12px;background:var(--teal);color:var(--ink);font:inherit;font-size:15px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;box-shadow:0 12px 30px -12px rgba(94,234,212,.4);transition:.18s}
        .cf-cta:hover:not(:disabled){transform:translateY(-1px)}
        .cf-cta:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
        .cf-reassure{font-size:12.5px;color:var(--muted);line-height:1.5}
        .cf-reassure b{color:var(--dim);font-weight:600}
        .cf-keybox{margin-top:12px;border:1px solid rgba(94,234,212,.3);background:rgba(94,234,212,.07);border-radius:12px;padding:12px 14px;font-size:13px;color:var(--dim);display:flex;align-items:center;justify-content:space-between;gap:12px}
        .cf-keybox a{color:var(--ink);background:var(--teal);padding:7px 13px;border-radius:9px;font-weight:600;text-decoration:none;white-space:nowrap}
        .cf-err{margin-top:12px;color:#FCA5A5;font-size:13px}
        .cf-examples{margin-top:24px;font-size:13px;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
        .cf-chip{padding:6px 12px;border:1px solid var(--bd);border-radius:999px;background:var(--surface);color:var(--dim);cursor:pointer;transition:.18s}
        .cf-chip:hover{border-color:rgba(94,234,212,.4);color:var(--text)}
        .cf-adv{display:flex;justify-content:center;padding:30px 0 50px}
        .cf-adv a{font-size:12.5px;color:var(--muted);text-decoration:none;padding:8px 14px;border:1px solid transparent;border-radius:999px;transition:.18s}
        .cf-adv a:hover{color:var(--dim);border-color:var(--bd)}
        .cf-nav-r{display:flex;align-items:center;gap:8px}
        .cf-nlink{font-size:13px;color:var(--dim);text-decoration:none;padding:7px 12px;border-radius:999px;border:1px solid transparent;transition:.18s}
        .cf-nlink:hover{color:var(--text);border-color:var(--bd)}
        .cf-recent{max-width:620px;margin:22px auto 0;text-align:left}
        .cf-recent .lbl{font-size:12px;color:var(--muted);margin-bottom:8px;letter-spacing:.02em}
        .cf-recent .row{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
        .cf-pj{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--bd);border-radius:12px;background:var(--surface);text-decoration:none;transition:.18s}
        .cf-pj:hover{border-color:var(--bd2);background:var(--surface2)}
        .cf-pj .dot{width:7px;height:7px;border-radius:999px;background:var(--teal);flex:none;box-shadow:0 0 8px var(--teal)}
        .cf-pj .nm{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        @media (prefers-reduced-motion:reduce){.cf-drop{animation:none}}
      `}</style>

      <div className="cf-amb" />
      <div className="cf-grid" />
      <div className="cf-wrap">
        <nav className="cf-nav">
          <div className="cf-brand">
            <span className="cf-mark">
              <svg width="16" height="16" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7" fill="#04221E" /><rect x="1" y="5" width="15" height="14" rx="3" fill="#04221E" /></svg>
            </span>
            ClipForge
          </div>
          <div className="cf-nav-r">
            <Link href="/products" className="cf-nlink">商品库</Link>
            <Link href="/batch" className="cf-nlink">批量</Link>
            <Link href="/settings" className="cf-gear" aria-label="设置">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </Link>
          </div>
        </nav>

        <section className="cf-hero">
          <div className="cf-eyebrow">AI 带货短视频工作台</div>
          <h1 className="cf-h1">丢张商品图，<span className="hl">直接出片</span></h1>
          <p className="cf-sub">上传商品图，或说一句话主题。AI 自动写脚本、配画面、配音，合成竖屏成片——先开跑，要用到 AI 时再配 Key。</p>

          <div className="cf-card">
            <div className="cf-tabs">
              <button className={`cf-tab${mode === "upload" ? " on" : ""}`} onClick={() => setMode("upload")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20" /></svg>
                上传商品图
              </button>
              <button className={`cf-tab${mode === "topic" ? " on" : ""}`} onClick={() => setMode("topic")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19v3" /><path d="M8 22h8" /><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /></svg>
                一句话成片
              </button>
            </div>

            {mode === "upload" ? (
              <>
                <div
                  className={`cf-drop${isDragging ? " drag" : ""}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                  onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
                >
                  <div className="cf-dic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg></div>
                  <div className="cf-dt">拖入商品图，或点击上传</div>
                  <div className="cf-ds">JPG / PNG，最多 5 张 · 没素材？下面点个示例</div>
                  <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
                </div>
                {images.length > 0 && (
                  <div className="cf-thumbs">
                    {images.map((i) => (
                      <div key={i.id} className="cf-thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={i.url} alt="商品图" />
                        <button onClick={(e) => { e.stopPropagation(); removeImage(i.id); }} aria-label="删除">×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="cf-field">
                  <input className="cf-input" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="商品名称（必填，如：便携榨汁杯）" />
                </div>
                <div className="cf-field">
                  <textarea className="cf-area" value={sellingPoints} onChange={(e) => setSellingPoints(e.target.value)} placeholder="核心卖点（选填）——填了脚本更精准" />
                </div>
              </>
            ) : (
              <div className="cf-field" style={{ marginTop: 0 }}>
                <textarea className="cf-area" style={{ minHeight: 120 }} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="说个主题，如：3 个让租房变高级的小物 / 冬天必囤的护手霜" />
              </div>
            )}

            {needKey && !llmReady ? (
              <div className="cf-keybox">
                <span>还没配 Key？脚本/画面需要先接一个 AI 平台。推荐 Atlas Cloud——一个 Key 搞定脚本+图+视频+配音。</span>
                <Link href="/settings">去配置</Link>
              </div>
            ) : (
              <div className="cf-cta-row">
                <button className="cf-cta" onClick={onStart} disabled={!canStart || busy}>
                  {busy ? (stage || "生成中…") : "开始生成"}
                  {!busy && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
                </button>
                <div className="cf-reassure">还没配 Key？开始时一键接 <b>Atlas Cloud</b>——脚本 + 图 + 视频 + 配音，一个 Key 全搞定。</div>
              </div>
            )}
            {error && <div className="cf-err">{error}</div>}
          </div>

          <div className="cf-examples">
            没素材，先试试
            {exampleProducts.slice(0, 3).map((ex) => (
              <span key={ex.id} className="cf-chip" onClick={() => fillExample(ex)}>{ex.name} ¥{ex.price}</span>
            ))}
          </div>

          {recent.length > 0 && (
            <div className="cf-recent">
              <div className="lbl">继续未完成的项目</div>
              <div className="row">
                {recent.map((p) => (
                  <Link key={p.id} href={`/project/${p.id}/${stepFor(p.status)}`} className="cf-pj">
                    <span className="dot" />
                    <span className="nm">{p.name || p.productName || "未命名项目"}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="cf-adv">
          <Link href="/settings">高级设置 · 多平台 / 自定义模型 / 生成参数 ›</Link>
        </div>
      </div>
    </div>
  );
}
