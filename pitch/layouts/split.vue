<script setup lang="ts">
defineProps<{
  num?: string
  kicker?: string
  ratio?: string
}>()
</script>

<template>
  <div class="slidev-layout split">
    <div class="split-head">
      <span v-if="num || kicker" class="section-num">
        <template v-if="num">§ {{ num }} — </template>{{ kicker ?? '' }}
      </span>
    </div>
    <div class="split-grid" :style="{ gridTemplateColumns: ratio ?? '5fr 7fr' }">
      <div class="left"><slot name="left" /></div>
      <div class="right"><slot name="right" /><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 40px 56px;
}
.split-head { margin-bottom: 28px; }
.split-grid {
  display: grid;
  gap: 56px;
  align-items: start;
}
.left, .right { min-width: 0; }
</style>
