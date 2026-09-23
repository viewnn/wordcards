# WordCards 云同步方案（Supabase）

> 解决的问题：手机和电脑各自把学习记录存在浏览器本地（IndexedDB），
> 两台设备互不相通。接入 Supabase 后，登录同一个账号即可共用一份学习进度。

---

## 一、方案总览

### 1.1 设计原则：本地优先（local-first）

```
              ┌──────────────────────── 一台设备 ────────────────────────┐
              │                                                          │
   用户操作 → │  IndexedDB（唯一真相源）  →  界面立刻更新（和以前一样快）  │
              │         │                                                │
              │         └─→ 脏标记队列 ─┐                               │
              │                          │ 防抖 2.5 秒后批量上行          │
              └──────────────────────────┼───────────────────────────────┘
                                         ▼
                              ┌──────────────────────┐
                              │      Supabase        │
                              │  word_progress 表    │
                              │  user_state 表       │
                              │  + RLS 行级安全      │
                              └──────────────────────┘
                                         │
                     切回前台 / 手动点同步 / 网络恢复
                                         ▼
                              增量下行 → 冲突合并 → 重算统计 → 刷新界面
```

关键点：**IndexedDB 仍然是唯一的数据真相源，Supabase 只做同步后端。**
所以断网、没登录、没配置 Supabase 时，应用的行为和改造前完全一致，
不会因为云端不可用而卡住或丢数据。

### 1.2 同步什么，不同步什么

| 内容 | 是否上云 | 说明 |
| --- | --- | --- |
| 词条学习状态（`status` / `favorite` / `lastStudied` / `reviewCount`） | ✅ | 核心数据，跨设备同步的主体 |
| 用户设置（每日目标、学习模式、重复频率、词典范围、音标渐显、各类开关） | ✅ | 10 个键，见 `cloud-sync.js` 的 `SYNCED_SETTING_KEYS` |
| 今日学习会话（今日队列 + 当前卡片下标） | ✅ | 换设备后能接着上次的地方背 |
| 「清除记录」动作 | ✅ | 按当前词典范围（字/短语/全部）清除：把该范围词条重置为 `new` 后走普通上行同步 |
| 词库本身（`dict.xlsx` 的 5794 个词条） | ❌ | 静态数据，每台设备本地导入即可，没必要占云端空间和流量 |
| 今日/累计统计数字 | ❌ | 完全可以从词条状态实时算出来，同步它反而会引入不一致 |
| 收藏以外的界面偏好、词典更新时间 | ❌ | 本机信息 |

---

## 二、数据库设计

完整建表脚本见 **`supabase/schema.sql`**，在 Supabase 控制台的 SQL Editor 里整段执行一次即可（幂等，可重复执行）。

### 2.1 `word_progress`：每个用户 × 每个词条一行

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | uuid | 归属用户，`auth.uid()` |
| `dict_key` | text | **跨设备词条标识**（见 2.3） |
| `status` | text | `new` / `mastered` / `review` |
| `favorite` | boolean | 是否收藏 |
| `last_studied` | bigint | 最近学习时间（客户端 epoch 毫秒） |
| `review_count` | integer | 复习次数（预留字段，与本地数据结构对齐） |
| `client_updated_at` | bigint | **客户端逻辑时间戳 —— 冲突判定的唯一依据** |
| `updated_at` | timestamptz | 服务端写入时间 —— 只用于增量拉取游标 |

主键 `(user_id, dict_key)`。

### 2.2 `user_state`：每个用户一行

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `settings` | jsonb | 参与同步的用户设置 |
| `settings_updated_at` | bigint | 设置的客户端逻辑时间戳（LWW） |
| `session` | jsonb | 今日会话 `{ date, currentCardIndex, goal, savedAt, dictKeys[] }` |
| `session_updated_at` | bigint | 会话的客户端逻辑时间戳（LWW） |
| `progress_reset_at` | bigint | 旧版「清除记录」的全局重置时间戳，**只增不减**。现在清除按词典范围生效，已不再写入；保留该列只为兼容旧版本设备 |

### 2.3 为什么用 `dict_key` 而不是词条 id

词条的 `id` 是 IndexedDB 的**自增主键**。同一份 `dict.xlsx` 在不同设备上
因为导入批次、历史删除等原因，同一个词完全可能拿到不同的 id，用它对齐必然错位。

所以用词条自身的内容拼出一个稳定标识：

```
dict_key = 分类 | 文本 | 音标        （全部规范化：去空白、合并空格、转小写）
例：word|你好|nei5 hou2
    phrase|食饭|sik6 faan6
```

`分类` 取 `word`（字）/ `phrase`（短语），与应用的「词典范围」概念一致。

**回退匹配**：词典更新时音标可能被纠正（readme 里就提到过「音标的纠错」），
这会让 `dict_key` 变化、学习记录对不上。因此下行合并时如果精确匹配失败，
会退化成「分类 + 文本」匹配 —— 只有当该文本在本地**唯一**时才采用，
多读音字这种「同文本多条」的情况宁可放弃，也绝不误配。

### 2.4 三个存储过程

PostgREST 的 `upsert` 不支持带条件的 `do update`，而「时间戳大的赢」正是
一种条件更新，所以走 RPC：

| 函数 | 作用 |
| --- | --- |
| `push_progress(p_rows jsonb)` | 批量上行；`on conflict ... where excluded.client_updated_at > 已有值`；**回传**这些词条在云端的最终状态，客户端据此纠正本地 |
| `push_user_state(...)` | 上行设置 / 会话 / 重置信号，各自按时间戳 LWW，重置信号取 `greatest` 只增不减（重置信号现在只用于兼容旧版本设备） |
| `delete_progress_before(p_before)` | 可选：清理重置时间点之前的历史行，让库保持干净（不影响正确性；不再由「清除」触发） |

三个函数都是 `security invoker`，RLS 照常生效。

---

## 三、同步算法

### 3.1 冲突解决：客户端时间戳 LWW

每次本地改动都会给词条盖上 `syncUpdatedAt`（毫秒时间戳），
它会**跟着词条一起写进 IndexedDB**，所以刷新页面、关掉浏览器都不会丢。

- **上行**：服务端只接受 `client_updated_at` 更大的版本
- **下行**：云端 `client_updated_at` 比本地大才覆盖本地

个人多设备场景下这个策略足够：同一张卡在两台设备上先后点不同状态时，**后点的赢**。

### 3.2 全量同步（`syncAll`）流程

```
1. 拉 user_state             → 设置 / 会话 / 重置信号
2. 应用重置信号               → 把 resetAt 之前的本地状态清零（之后的保留）
3. 全量拉 word_progress       → 丢弃 client_updated_at <= resetAt 的作废行
4. 建本地索引并双向合并：
     云端更晚 → 写入本地
     本地更晚 / 云端没有 → 收集起来准备上行
5. 批量上行（每批 300 条）
6. 设置：云端更新就用云端；本地更新就推上去
7. 会话：云端有今天的会话且本地没有 → 恢复；否则把本地的推上去
8. 重算统计 + 刷新学习页 / 词库页
```

### 3.3 同步时机（**全部自动，不需要手动点**）

| 时机 | 方向 | 动作 |
| --- | --- | --- |
| 启动时已登录 | 双向 | 全量同步 `syncAll` |
| 登录 / 注册成功 | 双向 | 全量同步 |
| 掌握 / 陌生 / 跳过 / 收藏 / 改设置 | 上行 | 打脏标记，**防抖 2.5 秒**后批量上行 |
| 页面切回前台 | 上行 + 下行 | 先冲刷待上传队列，再增量拉取（距上次 > 30 秒才拉） |
| **停留在前台时** | 下行 | **每 60 秒**自动增量检查一次，覆盖「另一台设备一直开着不动」的场景 |
| 网络恢复（`online`） | 双向 | 全量同步 |
| 页面切到后台 | 上行 | 立即冲刷待上传队列 |
| 点「同步」 | 双向 | 全量同步（手动兜底，平时用不到） |

所以正常情况下**你不需要碰那个按钮**：手机上学完，两三秒就上传了；
电脑这边最多一分钟就会自动拉下来。

想立刻看到结果时有两种更快的办法：**把浏览器标签页切走再切回来**
（会立即触发一次拉取），或者直接点「同步」。

设置页的「自动同步」开关关掉后，上面这些自动时机全部停用，
只保留手动点按钮 —— 改动仍然会被记录，只是不会自动上传。

> 注意：轮询和切前台走的是**增量拉取**，并且刻意**不重建今日学习队列**，
> 所以它不会在你正背单词时把卡片换掉；会话恢复只在登录、启动、
> 手动同步这类全量同步时进行。

### 3.4 「清除记录」如何跨设备生效

「清除」是**按词典范围**（字 / 短语 / 全部）生效的，所以不用广播全局重置信号，
而是把被清除的那批词条当成普通改动上行：

1. 设备 A 点清除 → 只把**当前范围**的词条状态重置为 `new`（并清掉 `last_studied`）
2. 这些词条经 `stampWord()` 拿到新的 `client_updated_at`，随普通上行队列推到云端
3. 云端 `push_progress` 按 `dict_key` 逐条覆盖成 `new`，**其它范围的行完全不动**
4. 设备 B 拉取增量时，按 LWW 应用这些行，于是只有对应范围被清零

> 早期版本走的是**只增不减的重置时间戳**（`user_state.progress_reset_at`）：
> 设备 A 点清除后写一个大时间戳，设备 B 同步时把「变更时间早于 T」的词条全部清零。
> 这个机制会把字和短语一起清掉，与「按范围清除」冲突，因此清除动作已不再写它；
> 代码里的 `applyRemoteReset()` 仍然保留，用于兼容旧版本设备发出的重置信号
> （`push_user_state` / `delete_progress_before` 两个 RPC 同理，保留但不再由清除触发）。

---

## 四、部署步骤

### 步骤 1：创建 Supabase 项目

1. 打开 <https://supabase.com>，注册并新建一个项目（免费额度足够个人使用）
2. 记下数据库密码（后面基本用不到，但要保存好）

### 步骤 2：建表

1. 进入项目 → 左侧 **SQL Editor** → **New query**
2. 把 `supabase/schema.sql` 的内容整段粘贴进去 → **Run**
3. 到 **Table Editor** 确认出现 `word_progress` 和 `user_state` 两张表
4. 到 **Authentication → Policies** 确认有 7 条策略

### 步骤 3：配置邮箱登录

1. **Authentication → Providers → Email**：确保已启用（默认启用）
2. **Authentication → URL Configuration**：
   - **Site URL**：填你的应用地址，例如 `http://localhost:8080`
   - **Redirect URLs**：把会用到的地址都加进去，例如
     `http://localhost:8080/**`、`http://192.168.1.10:8080/**`
     （用于邮箱确认链接和找回密码的跳转）
3. **Confirm email（邮箱验证）**：
   - **开启**（默认）：注册后需要去邮箱点确认链接才能登录，安全性更好
   - **关闭**：注册即登录，省事，适合自己用；两个都支持，代码会自动判断

> 国内收 Supabase 的确认邮件可能比较慢，自己用建议先关掉邮箱验证。

### 步骤 4：填配置

打开 **`supabase-config.js`**，填入项目地址和 anon key：

```js
window.SUPABASE_CONFIG = {
  url: 'https://abcdefghijklmn.supabase.co',   // Project Settings → API → Project URL
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...',  // Project Settings → API → anon public
  autoSync: true
};
```

> `anon key` 放在前端是 Supabase 的正常设计，它的权限完全由 RLS 决定。
> **绝对不要**把 `service_role` key 填进来 —— 那个能绕过 RLS。

> ⚠️ **`url` 只填到 `.supabase.co` 为止，不要带 `/rest/v1`。**
> Supabase 控制台的 API 页面上显示的是 `https://xxxx.supabase.co/rest/v1`，
> 但那是给直接调 REST 接口用的；`createClient()` 要的是**项目根地址**，
> SDK 自己会拼 `/auth/v1`（登录）和 `/rest/v1`（数据）。
>
> 多带这段路径会让注册/登录打到 `/rest/v1/auth/v1/signup`，返回
> `404 PGRST125 Invalid path specified`，**现象是「点了注册按钮完全没反应」**，
> 极难排查。代码里已做自动纠正并在控制台打印警告，但还是填对最稳妥。

### 步骤 5：部署并访问

把整个目录（含新增的 `cloud-sync.js` / `cloud-sync.css` / `supabase-config.js`）
一起部署。本地的话直接双击 `start_server8080.bat`。

⚠️ 必须通过 HTTP(S) 访问，不能用 `file://` 直接打开 ——
Supabase 的跨域请求和 IndexedDB 都需要正常的 origin。

⚠️ 手机和电脑要用**同一个账号**登录，学习记录才会合并。
在此之前两台设备的 IndexedDB 是互相独立的（不同 origin 本来就是两套存储）。

### 步骤 6：验证

1. 在手机上打开 → 设置 → 账号与同步 → 注册/登录
2. 背几个词，看到「已同步」徽标
3. 在电脑上打开 → 设置 → 账号与同步 → 登录同一账号
4. 电脑上应该立刻出现手机上的学习进度（顶部统计数字、词库页的分类筛选都会同步）
5. 在电脑上点「同步」或刷新页面，验证双向同步正常

---

## 五、代码结构

### 5.1 新增文件

| 文件 | 作用 |
| --- | --- |
| `supabase/schema.sql` | 数据库建表脚本（表 + RLS + RPC），在 Supabase 控制台执行一次 |
| `supabase-config.js` | 唯一需要你修改的文件：填 url 和 anonKey |
| `cloud-sync.js` | 同步引擎：认证、合并算法、自动同步、界面渲染 |
| `cloud-sync.css` | 账号与同步相关的样式（复用现有 CSS 变量，视觉与原来一致） |

### 5.2 对现有文件的改动

改动刻意压到最小，且**全部是"有则调用、无则跳过"的可选调用**，
不改变任何原有行为：

**`index.html`**
- `<head>` 里引入 supabase-js SDK、`cloud-sync.css`
- header 右侧加一个同步状态徽标 `#cloudBadge`，**始终可见**，点击跳到设置页。
  状态依次为：未启用 / 未登录 / 待同步 / 同步中 / 已同步 / 离线 / 同步异常
- 设置页新增「账号与同步」区块 `#cloudSection`（标题右侧带状态角标）
- 底部新增登录/注册弹窗与找回密码弹窗
- 脚本顺序：`supabase-config.js` → `cloud-sync.js` → `app.js`
- 「如何开启」引导面板**默认就是可见的**（HTML 里没写 `display:none`），
  即使 JS 完全没跑起来也不会是一片空白，而是给出明确的三步说明

**`app.js`**（4 个钩子，共约 20 行）

| 位置 | 钩子 | 作用 |
| --- | --- | --- |
| `VocabDB.updateWord()` | `CloudSync.stampWord(word)` | 写库前盖时间戳 + 记入待上传队列。放在 `updateWord` 这一层，一处改动覆盖了掌握/陌生/跳过/收藏/编辑等**所有**词条写入路径 |
| `VocabDB.setSetting()` | `CloudSync.onSettingWritten(key, value)` | 设置和今日会话写完后触发上传调度 |
| `VocabApp.init()` 末尾 | `CloudSync.attach(this)` | 启动云同步：恢复登录态、首次合并、注册网络/前台监听 |
| `VocabApp.clearProgress()` 末尾 | `CloudSync.onProgressCleared(scopeKeys)` | 把「按词典范围清除」同步出去：让刚被重置为 `new` 的词条立即上行，其它范围不受影响 |

因为都用了可选链 `?.`，**未加载 `cloud-sync.js` 时这些调用等于不存在**，
应用仍能独立运行。

### 5.3 未登录 / 未配置时的行为

| 状态 | 顶部徽标 | 设置页「账号与同步」 | 其它功能 |
| --- | --- | --- | --- |
| 没填 `supabase-config.js` | `未启用` | 显示「如何开启」三步引导 | 完全不变 |
| 填了但 SDK 没加载成功（CDN 挂掉） | `未启用` | 同上，并写明是 SDK 没加载 | 完全不变 |
| 已配置、未登录 | `未登录` | 显示「登录 / 注册」入口 | 完全不变 |
| 已登录、正常 | `已同步` / `同步中` / `待同步` | 显示邮箱、上次同步时间、「同步」按钮、自动同步开关、退出 | 云端记录自动双向合并 |
| 已登录但断网 | `离线` | 显示离线说明 | 正常背单词，记录存本机，联网后自动补传 |

> ⚠️ **未配置时不显示「登录」按钮是刻意的**：没填 `url` / `anonKey` 时登录必然失败，
> 摆一个点了没反应的按钮只会让人以为功能坏了。所以改成给出可执行的三步开启引导。

---

## 五点五、排查：看不到「登录 / 注册」入口

按下面的顺序检查，一步就能定位：

**① 顶部徽标现在显示什么？**（徽标在页面右上角，时间左边）

| 徽标 | 含义 | 怎么办 |
| --- | --- | --- |
| 连徽标都没有 | 浏览器给的是**旧页面** | 硬刷新：`Ctrl + Shift + R`（Mac 是 `Cmd + Shift + R`）；手机上清一下浏览器缓存 |
| `未启用` | 配置没填 或 SDK 没加载 | 见下面 ② ③ |
| `未登录` | 一切正常 | 进设置页点「登录」——登录弹窗是**点按钮才弹**的，不会自动出现 |
| `已同步` | 一切正常 | 已经登录了 |

**② 打开浏览器控制台（F12 → Console），看有没有这两行之一：**

```
[cloud-sync] 未配置 Supabase，云同步停用，应用以本地模式运行。
[cloud-sync] 未检测到 supabase-js SDK，云同步停用。
```

- 第一行 → `supabase-config.js` 里的 `url` 和 `anonKey` 还是空的，去填上
- 第二行 → Supabase 的 CDN 没加载成功。在控制台执行 `typeof window.supabase`
  确认一下，如果是 `undefined`，把 `index.html` 和 `supabase-config.js` 里的
  CDN 地址换成 unpkg 或 bootcdn（`supabase-config.js` 里有注释）

如果控制台**一行 `[cloud-sync]` 都没有**，说明 `cloud-sync.js` 压根没被执行到 ——
那基本就是浏览器缓存了旧的 `index.html`，硬刷新即可。

**③ 确认 `supabase-config.js` 真的填对了：**

```js
window.SUPABASE_CONFIG = {
  url: 'https://xxxxxxxx.supabase.co',   // 不能有空字符串
  anonKey: 'eyJhbGciOiJIUzI1NiIs...'     // 必须是 anon public，不是 service_role
};
```

在控制台执行 `SUPABASE_CONFIG` 可以直接看到当前生效的值。

**④ 注意 Service Worker。** 应用注册了 SW 做离线缓存。正常情况下它是
「网络优先」，刷新就能拿到新文件；万一卡在旧版本，可以到
浏览器 DevTools → Application → Service Workers 点 **Unregister**，
再刷新一次。

---

## 六、安全说明

1. **RLS 是唯一的安全边界**。两张表都启用了行级安全，策略为 `auth.uid() = user_id`，
   每个用户只能读写自己的数据。`anon key` 公开在前端是安全的。
2. **不要把 `service_role` key 放进任何前端文件**，它能绕过 RLS。
3. 密码由 Supabase Auth 管理（bcrypt 哈希），前端不接触明文存储。
4. 数据存在你自己的 Supabase 项目里，不会经过任何第三方服务器。
5. 如果词库涉及版权，注意：词库本身不上云，仍是本地文件。

---

## 七、常见问题

**Q：点了「注册」/「登录」完全没反应，怎么办？**
按可能性从高到低：

1. **`supabase-config.js` 的 `url` 多带了 `/rest/v1`**（最常见）。
   请求会 404，而错误提示如果被挡住就看着像"没反应"。
   正确写法：`https://xxxx.supabase.co`
2. **网络访问不了 supabase.co**。等 20 秒会出现「连接超时」提示。
3. **邮箱已注册过**。Supabase 出于安全不会明说，此时会提示去登录。
4. 打开 F12 控制台看有没有红色的 `[cloud-sync]` 或网络错误，
   错误信息现在会直接显示在弹窗里（红色背景那一块）。

**Q：登录后会不会覆盖我原有的本地记录？**
不会。登录后是**双向合并**：云端更晚的写入本地，本地更晚的上传云端，
两边都保留。只有同一张卡在两边都改过时，才会按时间戳取较晚的那次。

**Q：电脑上登录后没有立刻看到手机上的进度？**
检查：① 两端登录的是不是同一个邮箱；② 徽标是否显示「已同步」；
③ 点一次「同步」。另外，顶部统计是**按当前词典范围**算的，
如果你手机上看的是「字」、电脑上看的是「短语」，数字本来就不一样，
可以在设置里把「词典导入」调成一致。

**Q：跳过卡片会不会同步？**
会。跳过虽然不改状态，但会更新 `lastStudied`（影响「重复频率」筛选），
所以也会上云。

**Q：清除记录后，另一台设备上的记录会怎样？**
跟着清零，而且只清**同一个词典范围**。清除是把该范围词条重置为 `new` 后当普通改动上传的，
另一台设备拉取时逐条覆盖，所以「清除字」不会影响另一台的「短语」记录。
（旧版本用全局重置时间戳广播，会把字和短语一起清掉，已不再使用。）

**Q：能不能同步词库本身（换词典不用重新导入）？**
当前设计故意不同步：`dict.xlsx` 是静态数据，每台设备本地导入即可，
省流量也省云端空间。如果确实需要，可以把 xlsx 放到 Supabase Storage，
在 `autoLoadDict()` 里改成先拉云端、失败再读本地缓存。

**Q：想做到「手机上一改，电脑上立刻变」？**
现在是「切回前台时增量拉取」，最坏延迟约 60 秒。要实时的话可以开
Supabase Realtime：在控制台把 `word_progress` 加入 publication，
然后在 `cloud-sync.js` 的 `bootstrap()` 里订阅
`postgres_changes`（filter 用 `user_id=eq.<uid>`），
收到变更后调用现成的 `pullAndMerge()` 即可。

**Q：免费额度够用吗？**
远远够。每次上行只发送「有学习痕迹」的词条（新词、没收藏、没学过的不发），
一次学习会话通常也就几十条记录。

---

## 八、调试

浏览器控制台里有现成的调试工具：

```js
// 看某个词条的跨设备标识
CloudSyncDebug.makeDictKey(app.todayWords[0])

// 看当前同步状态与待上传队列
CloudSync.status
CloudSync.dirty.size
CloudSync.meta

// 手动触发一次全量同步
await CloudSync.syncAll('manual')
```

数据库端可以在 Supabase 控制台的 **Table Editor** 里直接查看
`word_progress` / `user_state` 的内容。
