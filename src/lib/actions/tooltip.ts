/**
 * Svelte action that shows an instant, styled tooltip on hover or focus.
 *
 * The tooltip element is appended to `document.body` (not the host element)
 * so it is never clipped by a card's bounds or `overflow` and always paints
 * above other content. It appears immediately — no native `title` delay — and
 * is wired to the trigger via `aria-describedby` for screen-reader users.
 *
 * Usage: `<button use:tooltip={'Explanatory text'}>`
 */
let counter = 0;

export function tooltip(node: HTMLElement, text: string | undefined) {
  let content = text;
  let tip: HTMLDivElement | null = null;
  const id = `tooltip-${++counter}`;
  const GAP = 8;
  const EDGE = 8;

  function position() {
    if (!tip) return;
    const anchor = node.getBoundingClientRect();
    const box = tip.getBoundingClientRect();

    // Prefer above the trigger; flip below when there isn't room.
    let top = anchor.top - box.height - GAP;
    if (top < EDGE) top = anchor.bottom + GAP;

    // Center horizontally, clamped to the viewport.
    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - box.width - EDGE));

    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function show() {
    if (!content || tip) return;
    tip = document.createElement('div');
    tip.className = 'tooltip-popover';
    tip.setAttribute('role', 'tooltip');
    tip.id = id;
    tip.textContent = content;
    document.body.appendChild(tip);
    node.setAttribute('aria-describedby', id);
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
  }

  function hide() {
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    node.removeAttribute('aria-describedby');
    if (tip) {
      tip.remove();
      tip = null;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') hide();
  }

  node.addEventListener('mouseenter', show);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focusin', show);
  node.addEventListener('focusout', hide);
  node.addEventListener('keydown', onKeydown);

  return {
    update(next: string | undefined) {
      content = next;
      if (!tip) return;
      if (!content) {
        hide();
      } else {
        tip.textContent = content;
        position();
      }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mouseleave', hide);
      node.removeEventListener('focusin', show);
      node.removeEventListener('focusout', hide);
      node.removeEventListener('keydown', onKeydown);
    },
  };
}
