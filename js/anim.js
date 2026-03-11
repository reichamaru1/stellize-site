// ================================
// Loader
// ================================
window.addEventListener("load", () => {
  const loader = document.getElementById("loader");
  if (loader) setTimeout(() => loader.classList.add("is-hidden"), 1750);
});

// ================================
// Page transition (全ページ派手の核心)
// ================================
const transition = document.getElementById("pageTransition");

const shouldHandleLink = (a) => {
  if (!a) return false;
  const href = a.getAttribute("href") || "";
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (a.target === "_blank") return false;
  if (a.hasAttribute("download")) return false;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  return true;
};

document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!shouldHandleLink(a)) return;

  // 同一ページの相対リンクのみ
  const url = a.href;
  if (!transition) return;

  e.preventDefault();
  transition.classList.add("is-on");

  // グワんグワん余韻
  setTimeout(() => {
    window.location.href = url;
  }, 520);
});

// 戻る/進むでもオーバーレイ残らないように
window.addEventListener("pageshow", () => {
  if (transition) transition.classList.remove("is-on");
});

// ================================
// Reveal / Stagger
// ================================
const revealEls = document.querySelectorAll(".reveal, .stagger");

const io = new IntersectionObserver(
  (entries, obs) => {
    entries.forEach((ent) => {
      if (!ent.isIntersecting) return;
      ent.target.classList.add("is-in");
      obs.unobserve(ent.target);
    });
  },
  { threshold: 0.12 }
);

revealEls.forEach((el) => io.observe(el));

// ================================
// Parallax (派手め・軽量)
// ================================
const parallaxImgs = document.querySelectorAll(".parallax-img");
let ticking = false;

const doParallax = () => {
  parallaxImgs.forEach((img) => {
    const rect = img.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const dist = center - window.innerHeight / 2;

    // 派手度（数値↑でグワんグワん）
    const strength = 0.14;

    const offset = dist * -strength;
    img.style.transform = `translateY(${offset}px) scale(1.05)`;
  });
  ticking = false;
};

const onScroll = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(doParallax);
};

window.addEventListener("scroll", onScroll, { passive: true });
doParallax();
/* =========================
   Page Transition (Stellize)
========================= */
.page-transition{
  position: fixed;
  inset: 0;
  z-index: 3000;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;

  /* Stellize tone */
  background: #f6f4f1;

  /* うっすらニュアンス（高級感） */
  background-image:
    radial-gradient(700px 320px at 20% 30%, rgba(168,155,191,0.18), transparent 60%),
    radial-gradient(640px 300px at 80% 70%, rgba(210,200,185,0.22), transparent 65%);
  filter: blur(0px);
  transition: opacity .45s ease, visibility .45s ease;
}

.page-transition.is-on{
  opacity: 1;
  visibility: visible;
}

/* 動きが苦手な人へ */
@media (prefers-reduced-motion: reduce){
  .page-transition{ transition: none; }
}