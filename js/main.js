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

