<script setup lang="ts">
defineProps<{
  title?: string
  meta?: string
}>()
</script>

<template>
  <div class="codewin">
    <div class="chrome">
      <span class="tab sel">{{ title ?? 'main.ts' }}</span>
      <span class="filler"></span>
      <span class="meta">{{ meta ?? 'scaffold · 2026' }}</span>
    </div>
    <div class="body"><slot /></div>
  </div>
</template>

<style scoped>
.codewin {
  background: var(--code-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-3);
  max-width: 1100px;
  width: 100%;
}
.chrome {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid color-mix(in srgb, var(--code-fg) 10%, transparent);
  padding-left: 16px;
}
.chrome .tab {
  padding: 12px 18px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: color-mix(in srgb, var(--code-fg) 55%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--code-fg) 10%, transparent);
  border-left: 1px solid color-mix(in srgb, var(--code-fg) 10%, transparent);
  letter-spacing: 0.02em;
}
.chrome .tab.sel {
  color: var(--code-fg);
  background: color-mix(in srgb, var(--code-fg) 4%, transparent);
  position: relative;
}
.chrome .tab.sel::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: var(--accent);
}
.chrome .filler { flex: 1; }
.chrome .meta {
  padding: 12px 18px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: color-mix(in srgb, var(--code-fg) 40%, transparent);
}
.body :deep(pre) {
  margin: 0;
  padding: 24px 28px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  color: var(--code-fg);
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  overflow-x: auto;
  font-feature-settings: "ss01";
}
.body :deep(code) {
  background: transparent !important;
  padding: 0 !important;
  color: inherit !important;
}
</style>
