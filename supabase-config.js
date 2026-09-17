/**
 * ============================================================
 * WordCards 云同步配置 —— supabase-config.js
 * ============================================================
 * 只需要修改这一个文件，就能接通自己的 Supabase 项目。
 * 这里填的内容会以明文出现在浏览器里，这是 Supabase 的正常设计：
 *   - anon public key 本来就是给前端用的（它的权限由数据库 RLS 决定）；
 *   - 绝对不要把 service_role key 填到这里，那个 key 能绕过 RLS。
 *
 * 两个值在 Supabase 控制台的这里找：
 *   项目 → 左下角 Project Settings（齿轮）→ API
 *     Project URL          → 下面 url
 *     Project API keys →
 *       anon / public      → 下面 anonKey
 *
 * 留空 = 关闭云同步，应用完全按本地模式运行（和以前一模一样）。
 * ============================================================
 */
window.SUPABASE_CONFIG = {
  /**
   * 项目根地址，形如 https://abcdefghijklmn.supabase.co
   *
   * ⚠️ 只填到 .supabase.co 为止：不要带 /rest/v1 或 /auth/v1。
   *    Supabase 控制台 API 页面上确实显示成
   *      https://xxxx.supabase.co/rest/v1
   *    但那是给 PostgREST 直接调接口用的；createClient() 要的是项目根地址，
   *    SDK 会自己拼 /auth/v1（登录）和 /rest/v1（数据）。
   *    多带路径会让注册/登录打到 /rest/v1/auth/v1/signup 上返回 404，
   *    现象就是「点了注册没反应」。代码里做了自动纠正，但还是填对最稳妥。
   */
  url: 'https://pklyrtkhnhayulctqpoy.supabase.co',

  /** anon / public key，一长串以 eyJ 开头的 JWT */
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrbHlydGtobmhheXVsY3RxcG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MjM4NDksImV4cCI6MjEwNTE5OTg0OX0.iW9mH8SYUC1ktB_gxInYyCHICJfG33zX-3-kz3XmWP0',

  /**
   * 登录后是否默认开启自动同步。
   * true  = 学习动作后自动上传、切换设备时自动拉取（推荐）
   * false = 只在你点「立即同步」时同步
   * 用户之后可以在设置页随时切换，选择会记在本机。
   */
  autoSync: true,

  /**
   * Supabase JS SDK 的 CDN 地址（index.html 里也用同一个）。
   * 如果 jsdelivr 访问不畅，可换成下面任意一个：
   *   https://unpkg.com/@supabase/supabase-js@2
   *   https://cdn.bootcdn.net/ajax/libs/supabase-js/2.45.4/supabase.min.js
   */
  sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
};
