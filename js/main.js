// ================================
// ローディング：描画→余韻→フェードアウト
// ================================
// Google Fonts 待ちで固まらないよう最大3.5秒でフォールバック
function hideLoader() {
  const loader = document.getElementById("loader");
  if (!loader) return;
  loader.classList.add("is-hidden");
}

window.addEventListener("load", () => setTimeout(hideLoader, 1900));
setTimeout(hideLoader, 3500);
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
// ③ reveal / fade-in（IntersectionObserver）
// ================================
const reveals = document.querySelectorAll(".reveal, .fade-in");

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
// ④ パララックス（軽量版：画像だけ控えめ）
// ================================
const parallaxImgs = document.querySelectorAll(".parallax-img");

let ticking = false;

const parallax = () => {
  const y = window.scrollY;

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

window.addEventListener("scroll", onScrollParallax, { passive: true });
parallax();
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

