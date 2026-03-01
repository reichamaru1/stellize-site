// Stellize コーポレートサイト - メインJavaScript
// フェードインアニメーション、スムーススクロール、ハンバーガーメニュー

document.addEventListener('DOMContentLoaded', function() {
    
    // ============================================
    // ハンバーガーメニューの制御
    // ============================================
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');
    
    if (hamburger && navMenu) {
        hamburger.addEventListener('click', function() {
            hamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });
        
        // メニューリンクをクリックしたらメニューを閉じる
        const navLinks = document.querySelectorAll('.nav-menu a');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                hamburger.classList.remove('active');
                navMenu.classList.remove('active');
            });
        });
    }
    
    // ============================================
    // フェードインアニメーション（スクロール連動）
    // ============================================
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, observerOptions);
    
    // .section と .fade-in クラスを持つ要素を監視
    const sections = document.querySelectorAll('.section, .fade-in');
    sections.forEach(section => {
        observer.observe(section);
    });
    
    // ============================================
    // スムーススクロール
    // ============================================
    const smoothScrollLinks = document.querySelectorAll('a[href^="#"]');
    smoothScrollLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            
            // # だけの場合はトップへ
            if (href === '#') {
                e.preventDefault();
                window.scrollTo({
                    top: 0,
                    behavior: 'smooth'
                });
                return;
            }
            
            // その他のアンカーリンク
            const targetId = href.substring(1);
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                e.preventDefault();
                const headerHeight = document.querySelector('.header').offsetHeight;
                const targetPosition = targetElement.offsetTop - headerHeight - 20;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
    
    // ============================================
    // ヘッダーのスクロール時スタイル変更
    // ============================================
    const header = document.querySelector('.header');
    let lastScroll = 0;
    
    window.addEventListener('scroll', function() {
        const currentScroll = window.pageYOffset;
        
        // 少しスクロールしたら影を濃くする
        if (currentScroll > 50) {
            header.style.boxShadow = '0 4px 16px rgba(74, 58, 42, 0.12)';
        } else {
            header.style.boxShadow = '0 2px 8px rgba(74, 58, 42, 0.08)';
        }
        
        lastScroll = currentScroll;
    });
    
    // ============================================
    // フォームバリデーション（お問い合わせページ用）
    // ============================================
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', function(e) {
            e.preventDefault();
            
            // バリデーション
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const message = document.getElementById('message').value.trim();
            
            if (!name || !email || !message) {
                alert('すべての項目をご入力ください。');
                return;
            }
            
            // メールアドレスの簡易チェック
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                alert('有効なメールアドレスをご入力ください。');
                return;
            }
            
            // 実際の送信処理はバックエンドと連携
            // ここではデモとして成功メッセージを表示
            alert('お問い合わせを受け付けました。\n担当者より3営業日以内にご連絡いたします。');
            contactForm.reset();
        });
    }
    
    // ============================================
    // アコーディオン（よくある質問用）
    // ============================================
    const accordionItems = document.querySelectorAll('.accordion-item');
    accordionItems.forEach(item => {
        const header = item.querySelector('.accordion-header');
        if (header) {
            header.addEventListener('click', function() {
                const isActive = item.classList.contains('active');
                
                // すべてのアコーディオンを閉じる
                accordionItems.forEach(otherItem => {
                    otherItem.classList.remove('active');
                });
                
                // クリックされたものが閉じていたら開く
                if (!isActive) {
                    item.classList.add('active');
                }
            });
        }
    });
    
    // ============================================
    // ページ読み込み時のアニメーション
    // ============================================
    window.addEventListener('load', function() {
        // ヒーローセクションをフェードイン
        const hero = document.querySelector('.hero');
        if (hero) {
            hero.style.opacity = '0';
            hero.style.transform = 'translateY(20px)';
            hero.style.transition = 'opacity 1s ease, transform 1s ease';
            
            setTimeout(function() {
                hero.style.opacity = '1';
                hero.style.transform = 'translateY(0)';
            }, 100);
        }
    });
});
