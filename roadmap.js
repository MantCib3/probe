'use strict';

document.querySelectorAll('.milestone').forEach(button => {
  button.addEventListener('click', () => {
    const detail = document.getElementById(button.getAttribute('aria-controls'));
    if (!detail) return;
    const willOpen = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(willOpen));
    detail.hidden = !willOpen;
    detail.classList.toggle('open', willOpen);
  });
});
