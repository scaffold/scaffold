<script setup lang="ts">
</script>

<template>
  <svg viewBox="0 0 800 440" class="dag" aria-hidden="true">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
      </marker>
    </defs>

    <!-- grid -->
    <g stroke="currentColor" stroke-width="0.5" opacity="0.08">
      <line v-for="x in 17" :key="`v${x}`" :x1="x*50" y1="0" :x2="x*50" y2="440"/>
      <line v-for="y in 10" :key="`h${y}`" x1="0" :y1="y*44" x2="800" :y2="y*44"/>
    </g>

    <!-- edges first -->
    <g stroke="currentColor" stroke-width="1.3" fill="none" opacity="0.55" marker-end="url(#arrow)">
      <path d="M120 220 L220 140"/>
      <path d="M120 220 L220 300"/>
      <path d="M240 140 L360 140"/>
      <path d="M240 300 L360 300"/>
      <path d="M380 140 L500 220"/>
      <path d="M380 300 L500 220"/>
      <path d="M520 220 L640 180"/>
      <path d="M520 220 L640 260"/>
    </g>

    <!-- block nodes -->
    <g font-family="JetBrains Mono" font-size="10" text-anchor="middle">
      <g>
        <rect x="80" y="200" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="100" y="225" fill="currentColor">G</text>
      </g>
      <g>
        <rect x="220" y="120" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="240" y="145" fill="currentColor">b1</text>
      </g>
      <g>
        <rect x="220" y="280" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="240" y="305" fill="currentColor">b2</text>
      </g>
      <g>
        <rect x="360" y="120" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="380" y="145" fill="currentColor">b3</text>
      </g>
      <g>
        <rect x="360" y="280" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="380" y="305" fill="currentColor">b4</text>
      </g>
      <g>
        <rect x="500" y="200" width="40" height="40" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.5"/>
        <text x="520" y="225" fill="var(--accent-contrast)">b5</text>
      </g>
      <g>
        <rect x="640" y="160" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="660" y="185" fill="currentColor">b6</text>
      </g>
      <g>
        <rect x="640" y="240" width="40" height="40" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
        <text x="660" y="265" fill="currentColor">b7</text>
      </g>
    </g>

    <!-- labels below the blocks -->
    <g font-family="JetBrains Mono" font-size="11" fill="currentColor" opacity="0.55">
      <text x="100" y="370" text-anchor="middle">genesis</text>
      <text x="520" y="370" text-anchor="middle" fill="var(--accent)" opacity="1">canonical</text>
    </g>

    <!-- x/y ticks -->
    <g font-family="JetBrains Mono" font-size="10" fill="currentColor" opacity="0.4">
      <text x="10" y="20">0,0</text>
      <text x="790" y="430" text-anchor="end">800,440</text>
    </g>
  </svg>
</template>

<style scoped>
.dag {
  width: 100%;
  height: auto;
  color: var(--fg);
  border: 1px solid var(--border);
  background: var(--bg-sunken);
  font-size: 10px;
}
.dag text { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
.dag text.tiny { font-size: 9px; }
.dag text.label { font-size: 12px; }
</style>
