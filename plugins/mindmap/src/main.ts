import { Markmap } from 'markmap-view';
import { connectToHost } from '../../host-channel';
import { createMindmapTransformer } from './transformer';

const host = connectToHost((data) => {
  if (data.type === 'content-update' && typeof data.content === 'string') {
    scheduleUpdate(data.content);
  } else if (data.type === 'theme-update' && data.theme && typeof data.theme === 'object') {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(data.theme as Record<string, string>)) {
      // Map --novelist-* to local CSS vars
      const localKey = key.replace('--novelist-', '--');
      root.style.setProperty(localKey, value);
    }
  }
});

const svgEl = document.getElementById('mindmap-svg') as unknown as SVGSVGElement;
const fitBtn = document.getElementById('fit-btn')!;

const transformer = createMindmapTransformer();
let mm: Markmap | null = null;
let lastContent = '';
let updateTimer: number | undefined;

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
  window.clearTimeout(updateTimer);
  updateTimer = window.setTimeout(() => updateMindmap(content), 300);
}

// Initialize markmap
mm = Markmap.create(svgEl, {
  autoFit: true,
  duration: 300,
  zoom: true,
  pan: true,
});

fitBtn.addEventListener('click', () => mm?.fit());

host.post({ type: 'plugin-ready' });
