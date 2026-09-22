export class ElementPicker {
  private host: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private target: Element | null = null;
  private raf = 0;
  private promoteTimer = 0;
  private active = false;
  constructor(private onPick: (element: Element) => void, private onStop: () => void) {}
  start() {
    if (this.active) return;
    this.active = true;
    const host = document.createElement('tokenlens-root');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important;overflow:visible!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>:host::backdrop{display:none}*{box-sizing:border-box}.box{position:fixed;border:1.5px solid #7762ff;background:#7762ff14;box-shadow:0 0 0 1px #fff5;pointer-events:none;display:none}.label{position:fixed;padding:6px 9px;border-radius:5px;background:#6652e8;color:white;font:11px/1.4 ui-monospace,SFMono-Regular,monospace;white-space:nowrap;box-shadow:0 3px 12px #0002;display:none}.hint{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:10px 15px;border:1px solid #ffffff22;border-radius:9px;background:#20212bed;color:#fff;font:12px/1.5 system-ui;box-shadow:0 8px 40px #0003}</style><div class="box"></div><div class="label"></div><div class="hint">Click to inspect an element <span style="opacity:.6"> · Esc to cancel</span></div>`;
    this.host = host; this.box = shadow.querySelector('.box'); this.label = shadow.querySelector('.label');
    document.documentElement.append(host);
    try { host.showPopover(); } catch { /* fallback uses high z-index */ }
    window.addEventListener('pointermove', this.move, true);
    window.addEventListener('pointerdown', this.block, true);
    window.addEventListener('mousedown', this.block, true);
    window.addEventListener('click', this.click, true);
    window.addEventListener('keydown', this.key, true);
    window.addEventListener('scroll', this.schedule, true);
    window.addEventListener('resize', this.schedule);
    this.promoteTimer = window.setInterval(() => {
      if (this.host && !this.host.isConnected) document.documentElement.append(this.host);
      if (this.host && document.querySelector('dialog[open]')) {
        try { this.host.hidePopover(); this.host.showPopover(); } catch { /* unsupported */ }
      }
    }, 500);
  }
  stop() {
    if (!this.active) return;
    this.active = false; cancelAnimationFrame(this.raf); this.raf = 0; clearInterval(this.promoteTimer);
    window.removeEventListener('pointermove', this.move, true); window.removeEventListener('pointerdown', this.block, true);
    window.removeEventListener('mousedown', this.block, true); window.removeEventListener('click', this.click, true);
    window.removeEventListener('keydown', this.key, true); window.removeEventListener('scroll', this.schedule, true); window.removeEventListener('resize', this.schedule);
    this.host?.remove(); this.host = this.box = this.label = this.target = null;
  }
  private block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  private key = (event: KeyboardEvent) => { if (event.key === 'Escape') { this.block(event); this.stop(); this.onStop(); } };
  private move = (event: PointerEvent) => {
    const first = event.composedPath().find(node => node instanceof Element && node !== this.host);
    this.target = first instanceof Element ? first : document.elementFromPoint(event.clientX, event.clientY);
    this.schedule();
  };
  private schedule = () => { if (!this.raf) this.raf = requestAnimationFrame(this.paint); };
  private paint = () => {
    this.raf = 0;
    if (!this.target?.isConnected || !this.box || !this.label) return;
    const rect = this.target.getBoundingClientRect();
    this.box.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    const name = this.target.tagName.toLowerCase() + (this.target.id ? `#${this.target.id}` : [...this.target.classList].slice(0, 2).map(c => `.${c}`).join(''));
    this.label.textContent = `${name}  ${Math.round(rect.width)} × ${Math.round(rect.height)}${this.target instanceof HTMLIFrameElement ? ' · iframe boundary' : ''}`;
    this.label.style.cssText = `display:block;left:${Math.max(4, Math.min(rect.left, innerWidth - 320))}px;top:${Math.max(4, rect.top > 32 ? rect.top - 29 : rect.bottom + 5)}px`;
  };
  private click = (event: MouseEvent) => {
    this.block(event);
    const target = event.composedPath().find(node => node instanceof Element && node !== this.host);
    this.stop(); if (target instanceof Element) this.onPick(target);
  };
}
