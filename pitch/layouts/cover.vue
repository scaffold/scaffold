<script setup lang="ts">
defineProps<{
  kicker?: string
}>()
</script>

<template>
  <div class="slidev-layout cover">
    <div class="brand-row">
      <img src="/logomark-white.png" alt="" />
      <span>Scaffold</span>
      <span class="v">v0.1</span>
    </div>

    <div class="cover-body">
      <slot />
    </div>

    <div class="cover-foot">
      <span class="eyebrow">April 2026 · Pitch</span>
      <span class="eyebrow">Scaffold.io</span>
    </div>
  </div>
</template>

<style scoped>
.cover {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 40px 56px;
  min-height: 100%;
}
.cover-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: 1200px;
}
.cover-foot {
  display: flex;
  justify-content: space-between;
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
</style>
