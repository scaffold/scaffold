import { assertEquals } from '@std/assert';
import { ReactiveRecordSet } from '../src/reactive/ReactiveRecordSet.ts';

// -- Test implementation -------------------------------------------

class TestRecordSet extends ReactiveRecordSet<string> {
  private items: string[] = [];

  getAll(): Iterable<string> {
    return this.items;
  }

  add(item: string): void {
    this.items.push(item);
    this.dispatchAdd(item);
  }

  remove(item: string): void {
    const idx = this.items.indexOf(item);
    if (idx !== -1) {
      this.items.splice(idx, 1);
      this.dispatchRemove(item);
    }
  }

  update(item: string): void {
    this.dispatchUpdate(item);
  }
}

// -- Tests ---------------------------------------------------------

Deno.test('ReactiveRecordSet: onAdd fires with correct record (sync)', () => {
  const set = new TestRecordSet({ debounceMs: 0 });
  const added: string[] = [];
  set.onAdd((record) => added.push(record));

  set.add('hello');

  assertEquals(added, ['hello']);
  set.dispose();
});

Deno.test('ReactiveRecordSet: onRemove fires with correct record', () => {
  const set = new TestRecordSet({ debounceMs: 0 });
  const removed: string[] = [];
  set.onRemove((record) => removed.push(record));

  set.add('hello');
  set.remove('hello');

  assertEquals(removed, ['hello']);
  set.dispose();
});

Deno.test('ReactiveRecordSet: onUpdate fires for specific record only', () => {
  const set = new TestRecordSet({ debounceMs: 0 });

  const updatesA: string[] = [];
  const updatesB: string[] = [];

  set.onUpdate('A', (r) => updatesA.push(r));
  set.onUpdate('B', (r) => updatesB.push(r));

  set.update('A');

  assertEquals(updatesA, ['A']);
  assertEquals(updatesB, []);
  set.dispose();
});

Deno.test('ReactiveRecordSet: offAdd removes callback', () => {
  const set = new TestRecordSet({ debounceMs: 0 });
  const added: string[] = [];
  const cb = (record: string) => added.push(record);

  set.onAdd(cb);
  set.add('first');
  set.offAdd(cb);
  set.add('second');

  assertEquals(added, ['first']);
  set.dispose();
});

Deno.test('ReactiveRecordSet: offUpdate removes callback', () => {
  const set = new TestRecordSet({ debounceMs: 0 });
  const updates: string[] = [];
  const cb = (record: string) => updates.push(record);

  set.onUpdate('X', cb);
  set.update('X');
  set.offUpdate('X', cb);
  set.update('X');

  assertEquals(updates, ['X']);
  set.dispose();
});

Deno.test('ReactiveRecordSet: debouncing batches multiple dispatches', async () => {
  const set = new TestRecordSet({ debounceMs: 5 });
  const added: string[] = [];
  set.onAdd((record) => added.push(record));

  // Dispatch multiple adds rapidly
  set.add('one');
  set.add('two');
  set.add('three');

  // Not yet fired (debounced)
  assertEquals(added, []);

  // Wait for debounce
  await new Promise((resolve) => setTimeout(resolve, 20));

  // All three should have fired in one batch
  assertEquals(added, ['one', 'two', 'three']);
  set.dispose();
});

Deno.test('ReactiveRecordSet: dispose clears pending timeouts and listeners', async () => {
  const set = new TestRecordSet({ debounceMs: 50 });
  const added: string[] = [];
  set.onAdd((record) => added.push(record));

  set.add('pending');
  set.dispose();

  // Wait past the debounce period
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Should NOT have fired since dispose cleared everything
  assertEquals(added, []);
});
