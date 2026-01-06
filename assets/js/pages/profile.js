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

  function mountModuleScript(src) {
    const old = document.querySelector(`script[data-partial-src="${src}"]`);
    if (old) old.remove();

    const s = document.createElement("script");
    s.type = "module";
    s.src = src;
    s.dataset.partialSrc = src;
    document.body.appendChild(s);
  }

  try { await inject("/partials/header.html", mountHeader); } catch (e) { console.warn(e); }
  try { await inject("/partials/footer.html", mountFooter); } catch (e) { console.warn(e); }

  // 주입 후 동작 스크립트 로드
  mountModuleScript("/assets/js/partials/header.js");
  mountModuleScript("/assets/js/partials/footer.js");
};
