import { SimEngine } from './SimEngine.ts';
import { DagRenderer } from './DagRenderer.ts';
import { NetworkRenderer } from './NetworkRenderer.ts';

// -- DOM --

const dagPanel = document.getElementById('dag-panel') as HTMLDivElement;
const netCanvas = document.getElementById('net-canvas') as HTMLCanvasElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
const speedLabel = document.getElementById('speed-label') as HTMLSpanElement;
const rateContainer = document.getElementById('rate-sliders') as HTMLDivElement;

// -- Engine & Renderers --

const engine = new SimEngine();
const dagRenderer = new DagRenderer(dagPanel);
const netRenderer = new NetworkRenderer(netCanvas);

// Wait for graphviz loaded by the CDN script
function waitForGraphviz(): Promise<unknown> {
  const gv = (globalThis as Record<string, unknown>).__graphviz;
  if (gv) return Promise.resolve(gv);
  return new Promise((resolve) => {
    const check = (): void => {
      const g = (globalThis as Record<string, unknown>).__graphviz;
      if (g) resolve(g);
      else setTimeout(check, 50);
    };
    check();
  });
}

waitForGraphviz().then((gv) => {
  dagRenderer.setGraphviz(gv as { layout(dot: string, format: string, engine: string): string });
});

// -- State --

let playing = true;
let simTicksPerSecond = 4;
let accumulator = 0;

// -- Populate controls --

// Play/Pause
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '\u23f8' : '\u25b6';
});

// Speed slider
speedSlider.addEventListener('input', () => {
  simTicksPerSecond = parseInt(speedSlider.value, 10);
  speedLabel.textContent = `${simTicksPerSecond} t/s`;
});

// Per-node rate sliders
for (let i = 0; i < engine.nodeNames.length; i++) {
  const wrapper = document.createElement('div');
  wrapper.className = 'rate-slider';

  const label = document.createElement('label');
  label.textContent = engine.nodeNames[i];
  label.style.color = `var(--node-${i})`;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '30';
  slider.value = String(engine.pubIntervals[i]);

  const val = document.createElement('span');
  val.textContent = String(engine.pubIntervals[i]);

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    engine.pubIntervals[i] = v;
    val.textContent = String(v);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(slider);
  wrapper.appendChild(val);
  rateContainer.appendChild(wrapper);
}

// -- Canvas sizing --

function resizeCanvas(): void {
  const netPanel = netCanvas.parentElement!;
  netCanvas.width = netPanel.clientWidth;
  netCanvas.height = netPanel.clientHeight;
  netRenderer.computePositions(engine.nodes.length);
}

globalThis.addEventListener('resize', resizeCanvas);
resizeCanvas();

// -- Mouse events --

netCanvas.addEventListener('click', (e) => {
  const rect = netCanvas.getBoundingClientRect();
  netRenderer.handleClick(engine, e.clientX - rect.left, e.clientY - rect.top);
});

// -- Animation loop --

let lastTime = 0;

function frame(time: number): void {
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;

  if (playing) {
    accumulator += dt * simTicksPerSecond;
    while (accumulator >= 1) {
      accumulator -= 1;
      engine.doTick();
    }
  }

  dagRenderer.render(engine);
  netRenderer.render(engine, -1, playing ? accumulator : 0);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
