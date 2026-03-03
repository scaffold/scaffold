import { SimEngine } from './SimEngine.ts';
import { BG, GRID, MUTED, nodeColor, TEXT } from './colors.ts';

const NODE_R = 20;
const LABEL_OFFSET = 30;

export class NetworkRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** Node positions in canvas space. */
  readonly nodePositions: { x: number; y: number }[] = [];

  /** Click selection state for toggling edges. */
  private selectedNode: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Compute circular positions for N nodes. */
  computePositions(n: number): void {
    const { width, height } = this.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(width, height) / 2 - 60;

    this.nodePositions.length = 0;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      this.nodePositions.push({
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      });
    }
  }

  render(engine: SimEngine, _viewerIdx: number, fractionalTick: number): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    if (this.nodePositions.length !== engine.nodes.length) {
      this.computePositions(engine.nodes.length);
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    // Draw edges
    for (let i = 0; i < engine.nodes.length; i++) {
      for (let j = i + 1; j < engine.nodes.length; j++) {
        if (!engine.isConnected(i, j)) continue;
        const a = this.nodePositions[i];
        const b = this.nodePositions[j];

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Draw in-flight message dots
    const currentTick = engine.tick + fractionalTick;
    for (const msg of engine.inFlight) {
      this.drawMessageDot(ctx, msg, currentTick, engine);
    }

    // Draw nodes
    for (let i = 0; i < engine.nodes.length; i++) {
      const pos = this.nodePositions[i];
      const color = nodeColor(i);
      const isSelected = i === this.selectedNode;

      // Selection highlight
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, NODE_R + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Label
      ctx.fillStyle = TEXT;
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(engine.nodeNames[i], pos.x, pos.y + LABEL_OFFSET);
    }
  }

  private drawMessageDot(
    ctx: CanvasRenderingContext2D,
    msg: InFlightMessage,
    currentTick: number,
    engine: SimEngine,
  ): void {
    const duration = msg.arriveTick - msg.departTick;
    if (duration <= 0) return;
    const t = Math.max(0, Math.min(1, (currentTick - msg.departTick) / duration));

    const from = this.nodePositions[msg.from];
    const to = this.nodePositions[msg.to];
    if (!from || !to) return;

    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;

    // Color by block creator
    const info = engine.blockInfos.get(msg.block.hash.toPrimitive());
    const color = info && info.creator >= 0 ? nodeColor(info.creator) : MUTED;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** Handle click: first click selects a node, second click toggles the edge. */
  handleClick(engine: SimEngine, canvasX: number, canvasY: number): void {
    const hitIdx = this.hitTestNode(canvasX, canvasY);

    if (hitIdx === null) {
      this.selectedNode = null;
      return;
    }

    if (this.selectedNode === null) {
      this.selectedNode = hitIdx;
    } else if (this.selectedNode === hitIdx) {
      this.selectedNode = null;
    } else {
      engine.toggleConnection(this.selectedNode, hitIdx);
      this.selectedNode = null;
    }
  }

  /** Hit test: returns node index at (px, py), or null. */
  private hitTestNode(px: number, py: number): number | null {
    for (let i = 0; i < this.nodePositions.length; i++) {
      const pos = this.nodePositions[i];
      const dx = px - pos.x;
      const dy = py - pos.y;
      if (dx * dx + dy * dy <= (NODE_R + 5) * (NODE_R + 5)) {
        return i;
      }
    }
    return null;
  }
}
