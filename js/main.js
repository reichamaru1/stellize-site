// ================================
// 動き抑制設定（各演出の無効化判定に共用）
// ================================
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ================================
// 軽量イベント計測（フェーズ4-19）
// GA4が設定済みならgtagへ、未設定でも将来差し替えやすいよう一元化。
// data-cta 属性を持つCTAのクリックを送信する。
// ================================
function trackEvent(name, params) {
  try {
    if (typeof window.gtag === "function" &&
        window.STELLIZE_GA_ID && window.STELLIZE_GA_ID !== "G-XXXXXXXXXX") {
      window.gtag("event", name, params || {});
    }
  } catch (e) { /* 計測失敗はUXを妨げない */ }
}
window.trackEvent = trackEvent;

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-cta]");
  if (!el) return;
  trackEvent("cta_click", { cta_type: el.dataset.cta, location: "home" });
});

// ③ 紹介：URLコピー（SNSシェアではなくコピー/メール転送前提）
(() => {
  const btn = document.getElementById("shareCopyBtn");
  if (!btn) return;
  const label = btn.textContent.trim();
  const url = btn.dataset.shareUrl || window.location.href;

  const showCopied = () => {
    btn.textContent = "コピーしました";
    btn.classList.add("is-copied");
    window.setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("is-copied");
    }, 2000);
  };

  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      showCopied();
    } catch (err) {
      // クリップボードAPI不可時のフォールバック（execCommand）
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); showCopied(); } catch (e2) {}
      ta.remove();
    }
  });
})();

// ================================
// ローディング：初回訪問のみ表示（sessionStorageでスキップ）
// 表示時間は最大1.1秒に収める
// ================================
function hideLoader() {
  const loader = document.getElementById("loader");
  if (!loader) return;
  loader.classList.add("is-hidden");
}

(() => {
  const VISITED_KEY = "stellize_visited";
  let visited = false;
  try {
    visited = sessionStorage.getItem(VISITED_KEY) === "1";
    sessionStorage.setItem(VISITED_KEY, "1");
  } catch (e) { /* プライベートモード等でsessionStorage不可なら毎回表示 */ }

  if (visited || REDUCED_MOTION) {
    // 2回目以降・動き抑制ユーザーは即座に非表示
    hideLoader();
    return;
  }

  // 初回：最大1.1秒で必ず閉じる（load完了が早ければ余韻0.4秒で閉じる）
  window.addEventListener("load", () => setTimeout(hideLoader, 400));
  setTimeout(hideLoader, 1100);
})();
// ================================
// ② ナビ：スクロールで透過 → 白背景
// ================================
const header = document.getElementById("siteHeader");

const onScrollHeader = () => {
  if (!header) return;
  if (window.scrollY > 10) header.classList.add("is-scrolled");
  else header.classList.remove("is-scrolled");
};

window.addEventListener("scroll", onScrollHeader, { passive: true });
onScrollHeader();

// ================================
// ③ reveal / fade-in / stagger（IntersectionObserver）
// 安全策：Observerが発火しない環境でも、画面内の要素は必ず表示する。
// ヒーロー等のファーストビューが opacity:0 のまま消えるのを防ぐ。
// ================================
const reveals = document.querySelectorAll(".reveal, .fade-in, .stagger");
const revealNow = (el) => el.classList.add("is-in");

if (REDUCED_MOTION || !("IntersectionObserver" in window)) {
  // 動き抑制・非対応環境では即座に全表示
  reveals.forEach(revealNow);
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          revealNow(e.target);
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0, rootMargin: "0px 0px -8% 0px" }
  );
  reveals.forEach((el) => io.observe(el));

  // フォールバック：ロード直後と1.2秒後に、ビューポート内の要素を確実に表示。
  // （Observerの初回発火が漏れてもファーストビューが消えないようにする）
  const revealInView = () => {
    reveals.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) revealNow(el);
    });
  };
  window.addEventListener("load", revealInView);
  setTimeout(revealInView, 1200);
}

// ================================
// 実績数字・受講者の声（フェーズ2-11-2）
// データと表示を分離：事業資料の完成後、下の定数を実データに
// 差し替えるだけで本実装になる。
// - STELLIZE_STATS: value を数値にすると CountUp 表示、null なら「準備中」
// - STELLIZE_VOICES: photo に画像パスを入れると写真表示、null ならイニシャル円
// ================================
const STELLIZE_STATS = [
  { label: "導入事業所数", value: null, suffix: "施設" },
  { label: "平均工賃向上率", value: null, suffix: "%" },
  { label: "受講者数", value: null, suffix: "名" },
  { label: "受講継続率", value: null, suffix: "%" },
];

// silhouette: "female" | "male"（写真が用意できたら photo に画像パスを入れると写真表示に切替）
const STELLIZE_VOICES = [
  {
    role: "受講生の声",
    comment: "未経験のSNSを0から学び、自分のペースでコツコツ発信を頑張って、先日初めて作品が売れました。",
    name: "Aさん",
    org: "千葉／ハンドメイド作家",
    photo: null,
    silhouette: "female"
  },
  {
    role: "導入施設の声",
    comment: "利用者同士のコミュニケーションが生まれたこと、講座を機にスマホを買い換えるなど、小さな一歩を踏み出せました。",
    name: "就労継続支援B型",
    org: "千葉",
    photo: null,
    silhouette: "male"
  },
  {
    role: "職員の声",
    comment: "未経験の職員が大半の中で、親身なサポートで利用者のフォローをしてくれました。",
    name: "就労継続支援B型",
    org: "東京",
    photo: null,
    silhouette: "female"
  },
];

// 実績数字のレンダリング + スクロール到達時CountUp
(() => {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;

  STELLIZE_STATS.forEach((stat) => {
    const item = document.createElement("div");
    item.className = "stat-item";
    // value未確定の間は「集計中」演出：ぼかした数字がパラパラ変わる
    const valueHtml = stat.value == null
      ? `<span class="stat-num stat-num--tally" data-tally aria-hidden="true">${Math.floor(Math.random() * 90) + 10}</span><span class="stat-suffix" aria-hidden="true">${stat.suffix}</span><span class="sr-only">集計中</span>`
      : `<span class="stat-num" data-count="${stat.value}">0</span><span class="stat-suffix">${stat.suffix}</span>`;
    const note = stat.value == null ? '<span class="stat-tally-note">集計中…</span>' : "";
    item.innerHTML = `<p class="stat-value">${valueHtml}</p><p class="stat-label">${stat.label}</p>${note}`;
    grid.appendChild(item);
  });

  // 集計中の数字をパラパラ回す（reduced-motion時は静止したぼかし数字のまま）
  const tallies = grid.querySelectorAll("[data-tally]");
  if (tallies.length && !REDUCED_MOTION) {
    setInterval(() => {
      tallies.forEach((el) => {
        el.textContent = String(Math.floor(Math.random() * 90) + 10);
      });
    }, 160);
  }

  const nums = grid.querySelectorAll(".stat-num[data-count]");
  if (!nums.length) return;

  const countUp = (el) => {
    const target = Number(el.dataset.count);
    if (REDUCED_MOTION || !Number.isFinite(target)) {
      el.textContent = String(target);
      return;
    }
    const DURATION = 1200;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / DURATION, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const statsIo = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        countUp(e.target);
        statsIo.unobserve(e.target);
      }
    });
  }, { threshold: 0.4 });
  nums.forEach((n) => statsIo.observe(n));
})();

// 受講者・導入施設の声のレンダリング
(() => {
  const grid = document.getElementById("voicesGrid");
  if (!grid) return;

  // 人物シルエット（女性・男性）。写真が無い間の匿名アバターとして使用
  const silhouette = (kind) => {
    const head = kind === "male"
      ? '<circle cx="20" cy="14" r="7"/>'
      : '<circle cx="20" cy="14" r="7"/>';
    // 肩のライン：femaleはやや丸く、maleはやや角ばらせて差をつける
    const body = kind === "male"
      ? '<path d="M6 40c0-8 6.3-13 14-13s14 5 14 13z"/>'
      : '<path d="M7 40c0-7.5 5.8-12.5 13-12.5S33 32.5 33 40c-2.5 1.2-7.5 1.8-13 1.8S9.5 41.2 7 40z"/>';
    return `<svg class="voice-silhouette" viewBox="0 0 40 42" aria-hidden="true">${head}${body}</svg>`;
  };

  STELLIZE_VOICES.forEach((voice) => {
    const card = document.createElement("div");
    card.className = "voice-card";
    const avatar = voice.photo
      ? `<img class="voice-photo" src="${voice.photo}" alt="" loading="lazy" decoding="async" width="60" height="60">`
      : `<div class="voice-photo voice-photo--sil voice-photo--${voice.silhouette || "female"}">${silhouette(voice.silhouette)}</div>`;
    const roleHtml = voice.role ? `<p class="voice-role">${voice.role}</p>` : "";
    card.innerHTML = `
      ${roleHtml}
      <p class="voice-comment">${voice.comment}</p>
      <div class="voice-head">
        ${avatar}
        <div>
          <p class="voice-name">${voice.name}</p>
          <p class="voice-org">${voice.org}</p>
        </div>
      </div>`;
    grid.appendChild(card);
  });
})();

// ================================
// FAQアコーディオン（faq.html / ホーム抜粋で共用）
// ================================
document.querySelectorAll(".accordion-header").forEach((header) => {
  const item = header.closest(".accordion-item");
  if (!item) return;
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");

  const toggle = () => {
    const isOpen = item.classList.toggle("active");
    header.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
});

// ================================
// ④ パララックス（rAFで間引き。reduced-motion/モバイルでは無効化）
// iOS Safari等ではスクロール連動transformがガクつくため、
// タッチ主体のデバイス・狭幅では動かさない
// ================================
const parallaxImgs = document.querySelectorAll(".parallax-img");
const isTouchLike = window.matchMedia("(pointer: coarse), (max-width: 768px)");

let ticking = false;

const parallax = () => {
  if (REDUCED_MOTION || isTouchLike.matches) {
    parallaxImgs.forEach((img) => { img.style.transform = ""; });
    ticking = false;
    return;
  }

  parallaxImgs.forEach((img) => {
    // 画像位置に応じて少しだけ動かす（やりすぎ注意）
    const rect = img.getBoundingClientRect();
    const offset = (rect.top + rect.height / 2 - window.innerHeight / 2) * -0.08;
    img.style.transform = `translateY(${offset}px)`;
  });

  ticking = false;
};

const onScrollParallax = () => {
  if (ticking) return;
  ticking = true;
  window.requestAnimationFrame(parallax);
};

if (parallaxImgs.length && !REDUCED_MOTION) {
  window.addEventListener("scroll", onScrollParallax, { passive: true });
  window.addEventListener("resize", onScrollParallax, { passive: true });
  parallax();
}
// ================================
// Page Transition (safe)
// ================================
(() => {
  const overlay = document.getElementById("pageTransition");
  if (!overlay) return;

  const DURATION = 420; // CSSのtransitionと合わせる
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const isSamePageHash = (a) => {
    const href = a.getAttribute("href") || "";
    return href.startsWith("#");
  };

  const isExternal = (a) => {
    try {
      const url = new URL(a.href, window.location.href);
      return url.origin !== window.location.origin;
    } catch {
      return true;
    }
  };

  const isNewTab = (a) => a.target === "_blank" || a.rel?.includes("external");

  const isSpecialScheme = (a) => {
    const href = (a.getAttribute("href") || "").trim();
    return /^(mailto:|tel:|sms:|javascript:)/i.test(href);
  };

  const shouldSkip = (a, e) => {
    if (!a) return true;
    if (e.defaultPrevented) return true;

    // 修飾キー押し（新規タブ/別動作）は邪魔しない
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;

    if (a.hasAttribute("download")) return true;
    if (isNewTab(a)) return true;
    if (isSamePageHash(a)) return true;
    if (isSpecialScheme(a)) return true;
    if (isExternal(a)) return true;

    // 同じURLへの遷移は無視
    try {
      const to = new URL(a.href, location.href);
      if (to.href === location.href) return true;
    } catch {}

    return false;
  };

  const on = () => overlay.classList.add("is-on");
  const off = () => overlay.classList.remove("is-on");

  // 戻る/進むでも一瞬だけ整える（任意）
  window.addEventListener("pageshow", () => {
    off();
  });

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    if (shouldSkip(a, e)) return;

    // ここから遷移を握る
    e.preventDefault();
    const href = a.href;

    if (reduced) {
      window.location.href = href;
      return;
    }

    on();
    window.setTimeout(() => {
      window.location.href = href;
    }, DURATION);
  });
})();

