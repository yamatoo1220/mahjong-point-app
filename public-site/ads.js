// 広告設定（Google AdSense の審査に通過したら client と slot を設定する）
// 未設定のあいだは何も読み込まず、広告枠も表示しない
(function () {
  const AD_CONFIG = {
    client: '', // 例: 'ca-pub-0000000000000000'
    bottomSlot: '' // 例: '1234567890'
  };

  if (!AD_CONFIG.client || !AD_CONFIG.bottomSlot) return;

  const container = document.getElementById('ad-bottom');
  if (!container) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CONFIG.client}`;
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);

  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'block';
  ins.dataset.adClient = AD_CONFIG.client;
  ins.dataset.adSlot = AD_CONFIG.bottomSlot;
  ins.dataset.adFormat = 'auto';
  ins.dataset.fullWidthResponsive = 'true';
  container.appendChild(ins);
  container.hidden = false;
  (window.adsbygoogle = window.adsbygoogle || []).push({});
})();
