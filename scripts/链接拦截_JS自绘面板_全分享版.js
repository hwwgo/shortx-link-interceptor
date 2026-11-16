/* =====================================================================
 * 「打开链接」应用集 → 底部选择面板（离屏 Bitmap 版 · 全分享版）
 *
 * 【为什么不能用 TextView —— 真机崩溃换来的约束】
 *   脚本经 Xposed 注入 system_server 主线程，未捕获异常 = 整机软重启。
 *   TextView.onDraw 里 Paint.setColor(int) 会把高 8 位 alpha 当成 ColorSpace id，
 *   抛 IllegalArgumentException("colorSpace must be an RGB color space")，
 *   该异常由系统 Choreographer 抛出、无人接收 → system_server 挂 → 软重启。
 *
 * 【所以本脚本】
 *   1. 面板整块离屏画到一张 Bitmap，屏幕上只放一个不可点击的 ImageView；
 *   2. 颜色一律 Paint.setARGB(a,r,g,b)，绝不用 setColor(int)；
 *      不使用 setBackgroundColor / setTextColor / ColorDrawable；
 *   3. 点击不靠子 View，靠矩形命中（ImageView 保持不可点击，触摸交给父 FrameLayout）；
 *   4. 全部 UI 操作包在 try 里，任何异常只降级，绝不让异常逃逸。
 *
 * 【本版：全部走「分享文本」】
 *   输入只有一条 URL 字符串，没有 Referer / Cookie / Headers 可带，
 *   所以统一用 ACTION_SEND + text/plain + EXTRA_TEXT 投递，语义上是"把链接分享给它"。
 *   两个开关控制行为：
 *     var SEND_ONLY = true;   // true  = 只走分享，失败红字提示（用来验证兼容面）
 *                             // false = 分享优先，失败退回「打开」和显式组件
 *     （本版已去掉 PREFER_SEND，探测只在 SEND_ONLY=false 时用到）
 *
 * 【v6 改动 —— 兼容只吃「分享」的下载器】
 *   原来点应用只用一种方式启动：ACTION_VIEW + data。像 Ghost Downloader(安卓)
 *   这种在 intent-filter 里声明了 mimeType、或只从 EXTRA_TEXT 取链接的应用会
 *   解析不到，startActivity 抛 ActivityNotFoundException 被吞掉 → 点了完全没反应。
 *   现在一个应用依次试 5 种投递方式（原样打开 → 带 BROWSABLE → 带 type → 分享文本
 *   → 分享任意类型），成功才关面板；全部失败就在面板里画一行红字提示，不再静默。
 *
 * 【v5 关键改动 —— 位置终于贴底】
 *   v4 之前是「先按屏幕尺寸画全屏位图，再挂窗」，一旦窗口实际高度 ≠ dm.heightPixels
 *   （overlay 被系统限制了可用区域），ImageView 的 FIT_XY 会把整张位图纵向压缩，
 *   卡片就整体往上飘，底部空出一大块 —— 就是反复出现的「离底部还有距离」。
 *   v5 改成两拍：
 *     ① 先把一个空的 FrameLayout 挂上去（不带 FLAG_LAYOUT_NO_LIMITS）；
 *     ② 等系统布局完成，再读 root.getWidth()/getHeight() 和 root.getRootWindowInsets()，
 *        按「窗口自己的真实尺寸」画位图、定位卡片。
 *   于是位图与窗口 1:1 像素对齐，卡片底边 = 窗口高 - 该窗口底部 inset - BOTTOM_GAP_DP，
 *   不管手势导航还是三大金刚键，都自动贴到该在的位置。
 *
 * 【数据来源】应用集由原生动作 ForEachPkgSet 遍历后写入局部变量 apps，
 *   JS 通过 localVarOf$apps 读取（脚本 API 没有 PkgSet 接口）。
 * ===================================================================== */
var __out;

(function () {

  var A = android;
  var LOG = [];
  function L(s) { if (LOG.length < 10) LOG.push(String(s)); }

  try {
    /* ---------------- 0. Context ---------------- */
    var ctx = null;
    try { if (context) ctx = context; } catch (e0) {}
    if (!ctx) { try { ctx = A.app.ActivityThread.currentApplication(); } catch (e1) {} }
    if (!ctx) { __out = "ERR|no-context"; return; }
    L("ctx");

    /* ---------------- 1. 链接 ---------------- */
    var targetUrl = "";
    try { targetUrl = String(url); } catch (e) {}
    if (!targetUrl || targetUrl === "null" || targetUrl === "undefined") targetUrl = "";
    if (!targetUrl) {
      try { if (typeof localVarOf$url !== "undefined") targetUrl = String(localVarOf$url); } catch (e) {}
    }
    if (!targetUrl) { __out = "ERR|no-url"; return; }
    L("url");

    /* ---------------- 2. 应用列表（原生动作写入的局部变量 apps） ---------------- */
    var raw = "";
    try {
      if (typeof localVarOf$apps !== "undefined") raw = String(localVarOf$apps);
    } catch (e) {}

    var pkgs = [];
    var parts = (raw || "").split(",");
    for (var i = 0; i < parts.length; i++) {
      var s0 = parts[i].replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
      if (s0 && s0 !== "null" && s0 !== "undefined" && pkgs.indexOf(s0) < 0) pkgs.push(s0);
    }
    L("apps:" + pkgs.length);

    var isFallback = false;
    if (pkgs.length === 0) {
      isFallback = true;
      try {
        var pmQ = ctx.getPackageManager();
        var ris = pmQ.queryIntentActivities(
          new A.content.Intent(A.content.Intent.ACTION_VIEW, A.net.Uri.parse(targetUrl)), 0);
        for (var m = 0; m < ris.size(); m++) {
          var qp = String(ris.get(m).activityInfo.packageName);
          if (qp && pkgs.indexOf(qp) < 0) pkgs.push(qp);
        }
      } catch (eFb) {}
      L("fb:" + pkgs.length);
    }

    /* ---------------- 3. 尺寸与配色（[a,r,g,b]，alpha 必须 255） ---------------- */
    var dm = ctx.getResources().getDisplayMetrics();
    var density = dm.density;
    function dp(v) { return Math.round(v * density); }

    var night = false;
    try { night = ((ctx.getResources().getConfiguration().uiMode & 0x30) === 0x20); } catch (e) {}

    var C_MASK  = [150, 0, 0, 0];
    var C_BG    = night ? [255, 38, 38, 42]    : [255, 252, 252, 253];
    var C_TITLE = night ? [255, 238, 238, 240] : [255, 20, 20, 20];
    var C_SUB   = night ? [255, 152, 152, 158] : [255, 130, 130, 136];
    var C_TEXT  = night ? [255, 232, 232, 236] : [255, 28, 28, 30];
    var C_LINE  = night ? [255, 62, 62, 68]    : [255, 233, 233, 237];
    var C_ACC   = night ? [255, 96, 154, 245]  : [255, 38, 108, 232];
    var C_WARN  = night ? [255, 226, 150, 90]  : [255, 200, 108, 38];

    var SW = dm.widthPixels;
    var SH = dm.heightPixels;

    var wm = ctx.getSystemService("window");
    if (!wm) { __out = "ERR|no-wm"; return; }

    /* ---------------- 3.1 导航栏高度（仅作 insets 取不到时的兜底） ---------------- */
    var navH = 0;
    var navOk = false;
    try {
      var wmi = wm.getCurrentWindowMetrics();
      navH = wmi.getWindowInsets().getInsets(7).bottom;   /* 7 = 状态栏|导航栏|标题栏 */
      navOk = true;
    } catch (eWi) {}
    if (!navOk) {
      try {
        var res0 = ctx.getResources();
        var idNav = res0.getIdentifier("navigation_bar_height", "dimen", "android");
        if (idNav > 0) navH = res0.getDimensionPixelSize(idNav);
      } catch (eNi) {}
    }
    if (navH < 0) navH = 0;
    if (navH > dp(80)) navH = dp(80);

    /* 卡片底边到「可显示区底边」的呼吸留白。
     * 想更贴底就调小（0 也合法），想抬起来就调大。 */
    var BOTTOM_GAP_DP = 6;
    L("nav:" + navH);

    /* ---------------- 4. 动作 ---------------- */
    var root = null;
    var iv = null;
    var HITS = [];        /* 命中矩形，paintPanel 写、触摸读（纯 JS 变量，不挂 Java 对象） */
    var CARD_Y = 0;
    var paintTries = 0;
    var NOTICE = "";      /* 面板内的失败提示（不用吐司） */

    var closeOverlay = function () {
      try { if (root) wm.removeView(root); } catch (eRv) {}
    };

    /* 失败提示画在面板里（不弹吐司）：先重绘一帧，3 秒后自动抹掉 */
    var showNotice = function (msg) {
      try {
        NOTICE = msg;
        mainH.post(new java.lang.Runnable({ run: function () { paintPanel(); } }));
        mainH.postDelayed(new java.lang.Runnable({
          run: function () {
            try { NOTICE = ""; paintPanel(); } catch (eN) {}
          }
        }), 3000);
      } catch (eSn) {}
    };

    /* 一个应用吃链接的方式不止一种，按「打开 → 打开+type → 分享 → 显式组件」投递。
     * 每次点击先用 resolveActivity 问系统「这个包能吃哪种」，命中即投，不盲试。 */
    var I_VIEW  = A.content.Intent.ACTION_VIEW;
    var I_SEND  = "android.intent.action.SEND";
    var I_TEXT  = "android.intent.extra.TEXT";

    var startIt = function (it) {
      try {
        it.addFlags(A.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
          if (!ctx.getPackageManager().resolveActivity(it, 0)) return false;
        } catch (eR) {}
        ctx.startActivity(it);
        return true;
      } catch (eSt) { return false; }
    };

    /* ① 打开：ACTION_VIEW + data（浏览器、1DM、ADM 都走这条） */
    var viewDataTo = function (pkg, u) {
      try {
        var i1 = new A.content.Intent(I_VIEW, u);
        i1.setPackage(pkg);
        if (startIt(i1)) return "view";
      } catch (e1) {}

      try {
        var i2 = new A.content.Intent(I_VIEW, u);
        i2.addCategory("android.intent.category.BROWSABLE");
        i2.setPackage(pkg);
        if (startIt(i2)) return "view+brow";
      } catch (e2) {}

      return "";
    };

    /* ② 打开 + type：filter 里写了 mimeType 的必须带 type 才匹配（Ghost Downloader） */
    var viewTTo = function (pkg, u) {
      try {
        var i3 = new A.content.Intent(I_VIEW);
        i3.setDataAndType(u, "*/*");
        i3.setPackage(pkg);
        if (startIt(i3)) return "view+type";
      } catch (e3) {}
      return "";
    };

    /* ③ 分享文本：从 EXTRA_TEXT 取链接的（FluxDown，以及绝大多数浏览器的"分享到"入口） */
    var sendTo = function (pkg) {
      try {
        var s1 = new A.content.Intent(I_SEND);
        s1.setType("text/plain");
        s1.putExtra(I_TEXT, targetUrl);
        s1.setPackage(pkg);
        if (startIt(s1)) return "send";
      } catch (e4) {}

      try {
        var s2 = new A.content.Intent(I_SEND);
        s2.setType("*/*");
        s2.putExtra(I_TEXT, targetUrl);
        s2.setPackage(pkg);
        if (startIt(s2)) return "send*";
      } catch (e5) {}

      return "";
    };

    /* ④ 显式组件兜底：拿它自己的启动 Activity，绕过 intent-filter 匹配 */
    var launchTo = function (pkg, u) {
      try {
        var li = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
        if (li) {
          try { li.setAction(I_VIEW); } catch (eA1) {}
          try { li.setData(u); } catch (eA2) {}
          try { li.putExtra(I_TEXT, targetUrl); } catch (eA3) {}
          if (startIt(li)) return "launch";
        }
      } catch (e6) {}
      return "";
    };

    /* ---- 能力探测：这个包对「当前这条链接」能吃哪几种投递 ----
     * 只查 3 次 resolveActivity，微秒级；探测全 false（如 package visibility 受限、
     * 或 filter 是运行时动态注册的）时退回全量尝试，行为与旧版一致。 */
    var probePkg = function (pkg, u) {
      var r = { view: false, viewT: false, send: false };
      var pm = null;
      try { pm = ctx.getPackageManager(); } catch (ePm) { return r; }
      if (!pm) return r;

      try {
        var p1 = new A.content.Intent(I_VIEW, u);
        p1.setPackage(pkg);
        r.view = pm.resolveActivity(p1, 0) != null;
      } catch (eP1) {}

      try {
        var p2 = new A.content.Intent(I_VIEW);
        p2.setDataAndType(u, "*/*");
        p2.setPackage(pkg);
        r.viewT = pm.resolveActivity(p2, 0) != null;
      } catch (eP2) {}

      try {
        var p3 = new A.content.Intent(I_SEND);
        p3.setType("text/plain");
        p3.setPackage(pkg);
        r.send = pm.resolveActivity(p3, 0) != null;
      } catch (eP3) {}

      return r;
    };

    /* ===== 投递策略：统一走「分享文本」 =====
     * SEND_ONLY = true  → 只发 ACTION_SEND，发不出去就在面板里红字提示，
     *                     不偷偷改用 VIEW（这样能真实反映"分享"的兼容面）
     * SEND_ONLY = false → 分享优先，失败再退回「打开」系列的探测投递 */
    var SEND_ONLY = true;

    var openWith = function (pkg) {
      var u = null;
      try { u = A.net.Uri.parse(targetUrl); } catch (eU) { return ""; }

      /* ① 统一入口：分享文本（text/plain → * /* 依次试） */
      var r = sendTo(pkg);
      if (r) return r;

      if (SEND_ONLY) {
        /* 分享发不出去，先分清两种情况：
         *   a) 能探测到它的能力，只是不含 SEND → 真的没有分享入口，交给红字提示；
         *   b) 三种能力全探测不到 → 很可能是 package visibility 受限（而非不支持），
         *      这时不能武断判失败，否则真机上会所有应用都点不动。走一遍兜底。 */
        var c = probePkg(pkg, u);
        if (!c.view && !c.viewT && !c.send) {
          r = viewDataTo(pkg, u); if (r) return r;
          r = viewTTo(pkg, u);    if (r) return r;
          return launchTo(pkg, u);
        }
        return "";
      }

      /* ② 分享不通，才考虑「打开」系列 */
      var cap = probePkg(pkg, u);
      if (cap.view)  { r = viewDataTo(pkg, u); if (r) return r; }
      if (cap.viewT) { r = viewTTo(pkg, u);    if (r) return r; }
      if (!cap.view && !cap.viewT) {
        r = viewDataTo(pkg, u); if (r) return r;
        r = viewTTo(pkg, u);    if (r) return r;
      }

      /* ③ 最后显式组件拉起 */
      return launchTo(pkg, u);
    };

    var copyUrl = function () {
      try {
        var cm = ctx.getSystemService("clipboard");
        if (!cm) return false;
        cm.setPrimaryClip(A.content.ClipData.newPlainText("url", targetUrl));
        return true;
      } catch (eCb) { return false; }
    };

    /* ---------------- 5. 同步切主线程 ---------------- */
    function runOnMain(fn) {
      var latch = new java.util.concurrent.CountDownLatch(1);
      var err = null;
      new A.os.Handler(A.os.Looper.getMainLooper()).post(new java.lang.Runnable({
        run: function () {
          try { fn(); } catch (e) { err = e; } finally { latch.countDown(); }
        }
      }));
      try { latch.await(8, java.util.concurrent.TimeUnit.SECONDS); } catch (eAw) { L("awaitTimeout"); }
      if (err) throw err;
    }

    var mainH = new A.os.Handler(A.os.Looper.getMainLooper());

    /* ---------------- 6. 按窗口真实尺寸绘制 ----------------
     * W/H 来自 root 实际布局结果；insB 来自该窗口自己的 WindowInsets。
     * 两者都拿不到时才退回 dm 与 navH。 */
    function paintPanel() {
      try {
        var W = root ? root.getWidth() : 0;
        var H = root ? root.getHeight() : 0;
        if (W <= 0 || H <= 0) {
          if (paintTries < 8) {
            paintTries++;
            mainH.postDelayed(new java.lang.Runnable({ run: function () { paintPanel(); } }), 40);
            return;
          }
          W = SW; H = SH;   /* 极端兜底：布局迟迟拿不到，按屏幕尺寸画 */
        }

        /* 该窗口底部被系统栏遮挡的高度（手势导航时通常为 0） */
        var insB = 0, insOk = false;
        try {
          var wi = root ? root.getRootWindowInsets() : null;
          if (wi) {
            try { insB = wi.getInsets(7).bottom; insOk = true; }
            catch (eW1) {
              try { insB = wi.getSystemWindowInsetBottom(); insOk = true; } catch (eW2) {}
            }
          }
        } catch (eW0) {}
        if (!insOk) insB = navH;
        if (insB < 0) insB = 0;

        var botGap = insB + dp(BOTTOM_GAP_DP);

        var PAD     = dp(18);
        var cardX   = dp(10);
        var cardW   = W - dp(20);
        var rowH    = dp(58);
        var titleH  = dp(28);
        var urlH    = dp(18);
        var tipH    = isFallback ? dp(18) : 0;
        var btnH    = dp(44);
        var topIn   = dp(16);
        var botIn   = dp(8);
        var gapTop  = dp(8);   /* 副标题与列表之间 */
        var gapBot  = dp(8);   /* 列表与按钮之间 */

        /* 固定部分总高：标题 + 链接 + (提示) + 间隙 + 只有「取消」一个 44dp 按钮 */
        var noticeH = NOTICE ? dp(20) : 0;
        var fixedH = topIn + titleH + urlH + tipH + noticeH + gapTop + gapBot + btnH + botIn;
        /* 顶部至少给状态栏留 48dp，不能顶出屏幕 */
        var availH = H - botGap - dp(48);

        var maxRows = Math.floor((availH - fixedH) / rowH);
        if (maxRows > 12) maxRows = 12;
        if (maxRows < 3) maxRows = 3;

        /* 应用太多：先压行高（不低于 46dp），还放不下才截断并提示 */
        if (pkgs.length > maxRows) {
          var fit = Math.floor((availH - fixedH) / pkgs.length);
          if (fit >= dp(46)) { rowH = fit; maxRows = pkgs.length; }
        }

        var rows      = pkgs.slice(0, maxRows);
        var truncated = pkgs.length - rows.length;
        var truncH    = truncated > 0 ? dp(18) : 0;
        var listH     = rows.length * rowH;
        var cardH     = fixedH + listH + truncH;
        var cardY     = H - botGap - cardH;
        if (cardY < dp(36)) cardY = dp(36);

        /* ---- 画布 ---- */
        var bmp = A.graphics.Bitmap.createBitmap(W, H, A.graphics.Bitmap.Config.ARGB_8888);
        var cvs = new A.graphics.Canvas(bmp);
        var p   = new A.graphics.Paint();
        p.setAntiAlias(true);

        function fillRR(x0, y0, x1, y1, r, c) {
          p.setStyle(A.graphics.Paint.Style.FILL);
          p.setARGB(c[0], c[1], c[2], c[3]);
          cvs.drawRoundRect(x0, y0, x1, y1, r, r, p);
        }
        function fillRect(x0, y0, x1, y1, c) {
          p.setStyle(A.graphics.Paint.Style.FILL);
          p.setARGB(c[0], c[1], c[2], c[3]);
          cvs.drawRect(x0, y0, x1, y1, p);
        }
        function text(t, x, baseY, size, c, bold) {
          p.setStyle(A.graphics.Paint.Style.FILL);
          p.setTextSize(size);
          p.setFakeBoldText(!!bold);
          p.setARGB(c[0], c[1], c[2], c[3]);
          cvs.drawText(String(t), x, baseY, p);
        }
        function measure(t, size) {
          p.setTextSize(size);
          return p.measureText(String(t));
        }
        function ellip(t, size, maxW) {
          var str = String(t);
          p.setTextSize(size);
          if (p.measureText(str) <= maxW) return str;
          var dot = p.measureText("…");
          var n = 0;
          try { n = p.breakText(str, true, maxW - dot, null); } catch (eB) { n = Math.floor(str.length / 2); }
          if (n < 0) n = 0;
          return str.substring(0, n) + "…";
        }

        /* ---- 遮罩 ---- */
        fillRect(0, 0, W, H, C_MASK);

        /* ---- 卡片 ---- */
        fillRR(cardX, cardY, cardX + cardW, cardY + cardH, dp(18), C_BG);

        var innerX = cardX + PAD;
        var innerW = cardW - PAD * 2;
        var yy = cardY + topIn;

        var hits = [];

        /* ---- 标题行：左边标题，右边「复制链接」 ---- */
        var copyT     = "复制链接";
        var copySz    = dp(13);
        var copyTW    = measure(copyT, copySz);
        var copyBtnW  = copyTW + dp(18);
        var copyBtnX1 = innerX + innerW;
        var copyBtnX0 = copyBtnX1 - copyBtnW;
        var copyBtnY0 = yy - dp(3);
        var copyBtnY1 = yy + dp(25);

        text(ellip("选择应用打开链接", dp(17), copyBtnX0 - dp(10) - innerX),
             innerX, yy + dp(18), dp(17), C_TITLE, true);
        text(copyT, copyBtnX0 + Math.round((copyBtnW - copyTW) / 2),
             yy + dp(15), copySz, C_ACC, false);

        hits.push({ y0: copyBtnY0, y1: copyBtnY1, kind: "copy",
                    xr: true, x0: copyBtnX0, x1: copyBtnX1 });

        yy += titleH;

        text(ellip(targetUrl, dp(11), innerW), innerX, yy + dp(12), dp(11), C_SUB, false);
        yy += urlH;

        if (isFallback) {
          var tip = pkgs.length === 0
            ? "应用集「打开链接」为空，也没有可处理该链接的应用"
            : "应用集「打开链接」为空，已列出可处理该链接的应用";
          text(ellip(tip, dp(11), innerW), innerX, yy + dp(12), dp(11), C_WARN, false);
          yy += tipH;
        }

        if (NOTICE) {
          text(ellip(NOTICE, dp(11), innerW), innerX, yy + dp(12), dp(11), C_WARN, false);
          yy += noticeH;
        }
        yy += gapTop;

        /* ---- 列表 ---- */
        var pm = null;
        try { pm = ctx.getPackageManager(); } catch (ePm) {}

        var listTop = yy;
        var iconSz = Math.max(dp(26), Math.min(dp(34), rowH - dp(14)));

        for (var r = 0; r < rows.length; r++) {
          var pkg = rows[r];
          var rowTop = listTop + r * rowH;

          var ix = innerX;
          var iy = rowTop + Math.round((rowH - iconSz) / 2);
          if (pm) {
            try {
              var dIcon = pm.getApplicationIcon(pkg);
              dIcon.setBounds(ix, iy, ix + iconSz, iy + iconSz);
              dIcon.draw(cvs);
            } catch (eIc) {
              fillRR(ix, iy, ix + iconSz, iy + iconSz, dp(8), C_LINE);
            }
          } else {
            fillRR(ix, iy, ix + iconSz, iy + iconSz, dp(8), C_LINE);
          }

          var label = pkg;
          if (pm) {
            try { label = String(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0))); } catch (eLb) {}
          }
          var tx = ix + iconSz + dp(12);
          var txW = innerX + innerW - tx;
          var midY = rowTop + Math.round(rowH / 2);
          text(ellip(label, dp(15), txW), tx, midY - dp(1), dp(15), C_TEXT, false);
          text(ellip(pkg, dp(10), txW), tx, midY + dp(14), dp(10), C_SUB, false);

          if (r < rows.length - 1) {
            fillRect(innerX, rowTop + rowH - 1, innerX + innerW, rowTop + rowH, C_LINE);
          }

          hits.push({ y0: rowTop, y1: rowTop + rowH, kind: "pkg", pkg: pkg, label: label });
        }

        yy = listTop + listH;

        /* ---- 截断提示（应用多于屏高时才有） ---- */
        if (truncated > 0) {
          fillRect(innerX, yy, innerX + innerW, yy + 1, C_LINE);
          var trT = "另有 " + truncated + " 个应用未显示（可精简「打开链接」应用集）";
          text(ellip(trT, dp(10), innerW), innerX, yy + dp(13), dp(10), C_SUB, false);
          yy += truncH;
        }

        yy += gapBot;

        /* ---- 取消（面板最后一项） ---- */
        fillRect(innerX, yy, innerX + innerW, yy + 1, C_LINE);
        text("取消", innerX + Math.round((innerW - measure("取消", dp(15))) / 2),
             yy + Math.round(btnH / 2) + dp(6), dp(15), C_SUB, false);
        hits.push({ y0: yy, y1: yy + btnH, kind: "cancel" });

        /* ---- 贴上图片 ---- */
        try { if (iv) root.removeView(iv); } catch (eRi) {}
        iv = new A.widget.ImageView(ctx);
        iv.setImageBitmap(bmp);
        try { iv.setScaleType(A.widget.ImageView.ScaleType.FIT_XY); } catch (eSc) {}
        iv.setClickable(false);
        iv.setFocusable(false);
        root.addView(iv, new A.widget.FrameLayout.LayoutParams(-1, -1));

        HITS = hits;
        CARD_Y = cardY;
        L("painted:" + W + "x" + H + ",insB:" + insB);
      } catch (ePaint) {
        L("paintErr:" + String(ePaint).substring(0, 40));
      }
    }

    /* ---------------- 7. 挂空窗 → 布局完成 → 绘制 ---------------- */
    runOnMain(function () {

      root = new A.widget.FrameLayout(ctx);

      var downY = -1, downX = -1;

      root.setOnTouchListener(new JavaAdapter(A.view.View.OnTouchListener, {
        onTouch: function (v, ev) {
          try {
            var act = ev.getActionMasked();
            if (act === 0) { downY = ev.getY(); downX = ev.getX(); return true; }
            if (act === 1) {
              var upY = ev.getY();
              var upX = ev.getX();
              if (downY >= 0 && Math.abs(upY - downY) < dp(16)) {
                for (var k = 0; k < HITS.length; k++) {
                  var h = HITS[k];
                  var inY = upY >= h.y0 && upY < h.y1;
                  var inX = !h.xr || (upX >= h.x0 && upX < h.x1);
                  if (inY && inX) {
                    if (h.kind === "pkg") {
                      var way = openWith(h.pkg);
                      if (way) {
                        closeOverlay();
                      } else {
                        showNotice("「" + (h.label || h.pkg) + "」没有接收分享的入口");
                      }
                    } else if (h.kind === "copy") {
                      copyUrl();
                      closeOverlay();
                    } else {
                      closeOverlay();
                    }
                    return true;
                  }
                }
                if (upY < CARD_Y) closeOverlay();
              }
              downY = -1; downX = -1;
              return true;
            }
            if (act === 3) { downY = -1; downX = -1; return true; }
          } catch (eT) {}
          return true;
        }
      }));

      var lp = new A.view.WindowManager.LayoutParams(
        A.view.WindowManager.LayoutParams.MATCH_PARENT,
        A.view.WindowManager.LayoutParams.MATCH_PARENT,
        A.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        A.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
          | A.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        A.graphics.PixelFormat.TRANSLUCENT);
      lp.gravity = A.view.Gravity.TOP | A.view.Gravity.LEFT;

      wm.addView(root, lp);
      L("shown");
    });

    /* 布局完成后再画（root 此时才有真实宽高） */
    mainH.postDelayed(new java.lang.Runnable({ run: function () { paintPanel(); } }), 60);

    __out = "OK|" + LOG.join("|");

  } catch (fatal) {
    var msg = String(fatal);
    if (msg.length > 80) msg = msg.substring(0, 80);
    __out = "ERR|" + msg + "|" + LOG.join("|");
    try {
      if (root) wm.removeView(root);
    } catch (eRm) {}
  }

})();

__out;
