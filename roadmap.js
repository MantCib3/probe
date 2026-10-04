'use strict';

document.querySelectorAll('.milestone').forEach(button => {
  const detailId = button.getAttribute('aria-controls');
  const detail = detailId ? document.getElementById(detailId) : null;
  if (!detail) return;

  let transitionId = 0;
  let activeTransitionId = 0;

  const finishTransition = () => {
    const isOpen = button.getAttribute('aria-expanded') === 'true';
    if (isOpen) {
      detail.style.height = 'auto';
    } else {
      detail.hidden = true;
      detail.classList.remove('open');
      detail.style.height = '0px';
    }
  };

  detail.addEventListener('transitionend', event => {
    if (event.target !== detail || event.propertyName !== 'height') return;
    if (activeTransitionId !== transitionId) return;
    const isOpen = button.getAttribute('aria-expanded') === 'true';
    const targetHeight = isOpen ? Number.parseFloat(detail.style.height) : 0;
    if (Number.isFinite(targetHeight) &&
        Math.abs(detail.getBoundingClientRect().height - targetHeight) < 1) {
      finishTransition();
    }
  });

  button.addEventListener('click', () => {
    const willOpen = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(willOpen));

    const currentHeight = detail.hidden ? 0 : detail.getBoundingClientRect().height;
    detail.hidden = false;
    detail.setAttribute('inert', '');
    if (willOpen) detail.removeAttribute('inert');
    detail.style.height = `${currentHeight}px`;
    detail.classList.toggle('open', willOpen);

    const currentTransition = ++transitionId;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      activeTransitionId = currentTransition;
      finishTransition();
      return;
    }

    requestAnimationFrame(() => {
      if (currentTransition !== transitionId) return;
      const targetHeight = willOpen ? detail.scrollHeight : 0;
      detail.style.height = `${targetHeight}px`;
      activeTransitionId = currentTransition;
      if (Math.abs(detail.getBoundingClientRect().height - targetHeight) < 1) {
        finishTransition();
      }
    });
  });
});
