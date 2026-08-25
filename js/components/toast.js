// PocketVault toast notifications.
let timer;

export function toast(message, type = "success") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("show"), 3500);
}
