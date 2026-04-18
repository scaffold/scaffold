<script setup lang="ts">
</script>

<template>
  <div class="slidev-layout end">
    <div class="end-body">
      <slot />
    </div>
    <div class="end-foot">
      <div class="brand-row">
        <img src="/logomark-white.png" alt="" />
        <span>Scaffold</span>
      </div>
      <span class="eyebrow">scaffold.github.io · 2026</span>
    </div>
  </div>
</template>

<style scoped>
.end {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 56px 56px 40px;
}
.end-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
</style>
