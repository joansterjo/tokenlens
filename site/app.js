const colorInput = document.querySelector('#brand-color');
const radiusInput = document.querySelector('#corner-radius');
const preview = document.querySelector('#demo-card');
const colorValue = document.querySelector('#color-value');
const radiusValue = document.querySelector('#radius-value');
const cssOutput = document.querySelector('#demo-css');
const swatches = Array.from(document.querySelectorAll('[data-color]'));
const copyButton = document.querySelector('#copy-demo');
const status = document.querySelector('#demo-status');
let resetCopy;

function updatePreview() {
  const color = colorInput.value.toLowerCase();
  const radius = `${radiusInput.value}px`;
  preview.style.setProperty('--demo-brand', color);
  preview.style.setProperty('--demo-radius', radius);
  colorValue.textContent = color.toUpperCase();
  radiusValue.textContent = radius;
  cssOutput.textContent = `:root { --brand: ${color}; --radius: ${radius}; }`;
  swatches.forEach((swatch) => {
    const selected = swatch.dataset.color === color;
    swatch.classList.toggle('is-selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
  });
}

swatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    colorInput.value = swatch.dataset.color;
    updatePreview();
  });
});
colorInput.addEventListener('input', updatePreview);
radiusInput.addEventListener('input', updatePreview);

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cssOutput.textContent);
    copyButton.querySelector('span').textContent = 'Copied!';
    status.textContent = 'Demo CSS copied to your clipboard.';
    clearTimeout(resetCopy);
    resetCopy = setTimeout(() => {
      copyButton.querySelector('span').textContent = 'Copy CSS';
    }, 2200);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(cssOutput);
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.querySelector('span').textContent = 'Press ⌘/Ctrl+C';
    status.textContent = 'CSS selected. Press Command C or Control C to copy.';
  }
});
