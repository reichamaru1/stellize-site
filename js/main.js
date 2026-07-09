// ================================
// 動き抑制設定（各演出の無効化判定に共用）
// ================================
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
// ================================
const reveals = document.querySelectorAll(".reveal, .fade-in, .stagger");

const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    });
  },
  { threshold: 0.12 }
);

reveals.forEach((el) => io.observe(el));

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

const STELLIZE_VOICES = [
  { name: "準備中", org: "受講者の声", photo: null, comment: "受講者様の声は現在準備中です。事業資料の完成にあわせて掲載します。" },
  { name: "準備中", org: "導入施設の声", photo: null, comment: "導入施設様の声は現在準備中です。事業資料の完成にあわせて掲載します。" },
  { name: "準備中", org: "職員の声", photo: null, comment: "施設職員様の声は現在準備中です。事業資料の完成にあわせて掲載します。" },
];

// 実績数字のレンダリング + スクロール到達時CountUp
(() => {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;

  STELLIZE_STATS.forEach((stat) => {
    const item = document.createElement("div");
    item.className = "stat-item";
    const valueHtml = stat.value == null
      ? '<span class="stat-num stat-num--pending">準備中</span>'
      : `<span class="stat-num" data-count="${stat.value}">0</span><span class="stat-suffix">${stat.suffix}</span>`;
    item.innerHTML = `<p class="stat-value">${valueHtml}</p><p class="stat-label">${stat.label}</p>`;
    grid.appendChild(item);
  });

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

  STELLIZE_VOICES.forEach((voice) => {
    const card = document.createElement("div");
    card.className = "voice-card";
    const photoHtml = voice.photo
      ? `<img class="voice-photo" src="${voice.photo}" alt="${voice.name}" loading="lazy" decoding="async" width="60" height="60">`
      : `<div class="voice-photo voice-photo--placeholder" aria-hidden="true">${(voice.name || "S").charAt(0)}</div>`;
    card.innerHTML = `
      <div class="voice-head">
        ${photoHtml}
        <div>
          <p class="voice-name">${voice.name}</p>
          <p class="voice-org">${voice.org}</p>
        </div>
      </div>
      <p class="voice-comment">${voice.comment}</p>`;
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

