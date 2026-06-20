import { redirect } from "next/navigation";

// 首页直接进入新版「先做后配」落地页 /start。
// 旧首页（项目列表 + 入口卡片）的能力已并入 /start：上传/一句话双入口、最近项目续作、商品库/批量/设置入口。
export default function HomePage() {
  redirect("/start");
}
