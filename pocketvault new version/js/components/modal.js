// PocketVault shared modal helpers.
export function getModalRoot() {
  return document.getElementById("modal-root");
}

export function openModal(html) {
  const root = getModalRoot();
  if (!root) return null;
  root.innerHTML = html;
  root.classList.add("open");
  return root;
}

export function closeModal() {
  const root = getModalRoot();
  if (!root) return;
  root.classList.remove("open");
  root.innerHTML = "";
}

export function showModalError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.style.display = "block";
}
