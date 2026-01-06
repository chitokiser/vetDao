// /assets/js/partials.js
// export 없이 전역 함수 제공
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
};

