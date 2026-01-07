// /assets/js/partials.js
window.loadPartials = async function loadPartials() {
  const mountHeader = document.getElementById("site-header");
  const mountFooter = document.getElementById("site-footer");

  async function inject(url, mount) {
    if (!mount) return;
    const res = await fetch(url);
    const html = await res.text();
    mount.innerHTML = html;
  }

  try { await inject("/partials/header.html", mountHeader); } catch (e) { console.warn(e); }
  try { await inject("/partials/footer.html", mountFooter); } catch (e) { console.warn(e); }

  // 주입 완료 이벤트 (header-wallet이 이걸 듣고 바인딩)
  window.dispatchEvent(new Event("partials:loaded"));
};
