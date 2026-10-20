// Mobile navigation toggle (CSP-safe, no dependencies).
document.querySelector(".nav-toggle")?.addEventListener("click", (event) => {
  const menu = document.querySelector(".nav-mobile");
  if (!(menu instanceof HTMLElement) || !(event.currentTarget instanceof HTMLElement)) return;
  const open = menu.toggleAttribute("hidden") === false;
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
