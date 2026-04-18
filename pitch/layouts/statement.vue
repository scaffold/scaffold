<script setup lang="ts">
defineProps<{
  kicker?: string
}>()
</script>

<template>
  <div class="slidev-layout statement">
    <div class="sm-head">
      <span v-if="kicker" class="eyebrow">{{ kicker }}</span>
    </div>
    <div class="sm-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.statement {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 40px 56px;
  text-align: center;
}
.sm-head { margin-bottom: 40px; }
.sm-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
}
.sm-body :deep(.sub),
.sm-body :deep(h1),
.sm-body :deep(h2),
.sm-body :deep(p) {
  margin-left: auto;
  margin-right: auto;
}
</style>
