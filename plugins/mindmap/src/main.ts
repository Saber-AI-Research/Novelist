import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const svgEl = document.getElementById('mindmap-svg') as unknown as SVGSVGElement;
const fitBtn = document.getElementById('fit-btn')!;

const transformer = new Transformer();
let mm: Markmap | null = null;
let lastContent = '';
let updateTimer: ReturnType<typeof setTimeout> | null = null;

function updateMindmap(content: string) {
  if (content === lastContent && mm) return;
  lastContent = content;

  const { root } = transformer.transform(content);
  if (mm) {
    mm.setData(root);
    mm.fit();
  }
}

function scheduleUpdate(content: string) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => updateMindmap(content), 300);
}

// Initialize markmap
mm = Markmap.create(svgEl, {
  autoFit: true,
  duration: 300,
  zoom: true,
  pan: true,
});

fitBtn.addEventListener('click', () => mm?.fit());

// Listen for messages from host
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'content-update' && typeof data.content === 'string') {
    scheduleUpdate(data.content);
  } else if (data.type === 'theme-update' && data.theme) {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(data.theme as Record<string, string>)) {
      // Map --novelist-* to local CSS vars
      const localKey = key.replace('--novelist-', '--');
      root.style.setProperty(localKey, value);
    }
  }
});

// Notify host we're ready
window.parent.postMessage({ type: 'plugin-ready' }, '*');
