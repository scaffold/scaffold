<script setup lang="ts">
defineProps<{
  num?: string
  kicker?: string
}>()
</script>

<template>
  <div class="slidev-layout section">
    <div class="head">
      <div>
        <span class="section-num">§ {{ num ?? '00' }} — {{ kicker ?? 'Section' }}</span>
      </div>
    </div>

    <div class="body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.section {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 40px 56px;
}
.head { margin-bottom: 24px; }
.body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-self: center;
  max-width: 1280px;
  width: 100%;
}
</style>
