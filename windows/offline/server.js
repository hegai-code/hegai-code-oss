// Окно «Сервер…». Свой файл, а не inline: CSP приложения — default-src 'self'.
(function () {
  var input = document.getElementById("url");
  var err = document.getElementById("err");
  var save = document.getElementById("save");
  var reset = document.getElementById("reset");
  var def = window.__HEGAI_DEFAULT_HUB__ || "https://code.acme.test";
  input.value = window.__HEGAI_HUB__ || def;

  function show(msg) { err.textContent = msg || ""; }
  function busy(b) { save.disabled = b; reset.disabled = b; }

  function send(url) {
    show("");
    busy(true);
    var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (!invoke) { busy(false); show("Окно не связано с приложением."); return; }
    // При успехе приложение перезапускается и этот вызов не возвращается.
    invoke("shell_set_hub", { url: url }).catch(function (e) {
      busy(false);
      show(typeof e === "string" ? e : "Не получилось сохранить.");
    });
  }

  function valid(v) {
    try {
      var u = new URL(v);
      var loop = u.hostname === "localhost" || u.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) return false;
      return (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username;
    } catch (_) { return false; }
  }

  save.addEventListener("click", function () {
    var v = input.value.trim();
    if (!valid(v)) {
      show("Нужен адрес вида https://code.example.com — без пути и параметров.");
      return;
    }
    send(v);
  });
  reset.addEventListener("click", function () { send(null); });
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") save.click(); });
})();
