/** Slide-in fullscreen menu: open/close plus focus handling. */

const menu = document.getElementById('menu');
const openBtn = document.getElementById('menu-open');
const closeBtn = document.getElementById('menu-close');
const backdrop = document.getElementById('menu-backdrop');
const links = menu ? menu.querySelectorAll('.menu__link') : [];

function setMenu(open) {
  if (!menu || !openBtn) return;

  menu.classList.toggle('is-open', open);
  openBtn.setAttribute('aria-expanded', String(open));

  if (open) {
    closeBtn?.focus({ preventScroll: true });
  } else {
    openBtn.focus({ preventScroll: true });
  }
}

openBtn?.addEventListener('click', () => setMenu(true));
closeBtn?.addEventListener('click', () => setMenu(false));
backdrop?.addEventListener('click', () => setMenu(false));
links.forEach((link) => link.addEventListener('click', () => setMenu(false)));

document.addEventListener('keydown', (e) => {
  // Escape only acts while the menu is open.
  if (e.key === 'Escape' && menu?.classList.contains('is-open')) setMenu(false);
});
