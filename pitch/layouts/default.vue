<script setup lang="ts">
defineProps<{
  num?: string
  kicker?: string
}>()
</script>

<template>
  <div class="slidev-layout default-s">
    <div class="head" v-if="num || kicker">
      <span class="section-num">
        <template v-if="num">§ {{ num }} — </template>{{ kicker ?? '' }}
      </span>
    </div>
    <div class="body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.default-s {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 40px 56px;
}
.head { margin-bottom: 24px; }
.body {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  max-width: 1400px;
  width: 100%;
}
</style>
