<script setup lang="ts">
</script>

<template>
  <svg viewBox="0 0 600 540" class="arch" aria-hidden="true">
    <defs>
      <pattern id="bpgrid" width="30" height="30" patternUnits="userSpaceOnUse">
        <path d="M30 0 L0 0 L0 30" stroke="currentColor" stroke-width="0.5" fill="none" opacity="0.1"/>
      </pattern>
    </defs>
    <rect width="600" height="540" fill="url(#bpgrid)" />

    <!-- concentric range circles -->
    <g stroke="currentColor" fill="none" stroke-width="1.2" opacity="0.6">
      <circle cx="300" cy="270" r="60" stroke-dasharray="3 3"/>
      <circle cx="300" cy="270" r="120" stroke-dasharray="2 6" opacity="0.5"/>
      <circle cx="300" cy="270" r="200" stroke-dasharray="2 10" opacity="0.25"/>
    </g>

    <!-- peers -->
    <g>
      <g transform="translate(80,100)">
        <rect width="64" height="36" fill="var(--bg)" stroke="currentColor" stroke-width="1.3"/>
        <text x="32" y="22" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="currentColor">peer</text>
      </g>
      <g transform="translate(460,80)">
        <rect width="64" height="36" fill="var(--bg)" stroke="currentColor" stroke-width="1.3"/>
        <text x="32" y="22" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="currentColor">peer</text>
      </g>
      <g transform="translate(40,400)">
        <rect width="64" height="36" fill="var(--bg)" stroke="currentColor" stroke-width="1.3"/>
        <text x="32" y="22" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="currentColor">peer</text>
      </g>
      <g transform="translate(490,420)">
        <rect width="64" height="36" fill="var(--bg)" stroke="currentColor" stroke-width="1.3"/>
        <text x="32" y="22" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="currentColor">peer</text>
      </g>
    </g>

    <!-- center client -->
    <g transform="translate(260,242)">
      <rect width="80" height="56" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"/>
      <text x="40" y="34" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="var(--accent-contrast)" font-weight="600">client</text>
    </g>

    <!-- connecting lines -->
    <g stroke="currentColor" stroke-width="1" fill="none" opacity="0.4">
      <path d="M144 120 L270 250" stroke-dasharray="4 3"/>
      <path d="M460 110 L330 250" stroke-dasharray="4 3"/>
      <path d="M104 420 L270 290" stroke-dasharray="4 3"/>
      <path d="M490 430 L330 290" stroke-dasharray="4 3"/>
    </g>

    <!-- tick marks -->
    <g font-family="JetBrains Mono" font-size="9" fill="currentColor" opacity="0.45">
      <text x="10" y="18">0,0</text>
      <text x="545" y="530">600,540</text>
    </g>
  </svg>
</template>

<style scoped>
.arch {
  width: 100%;
  height: auto;
  color: var(--fg);
  border: 1px solid var(--border);
  background:
    radial-gradient(circle at center, transparent 30%, color-mix(in srgb, var(--accent) 4%, transparent) 65%, transparent 95%);
}
.arch text { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
</style>
