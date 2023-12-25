export const enum SlotFlags {
  /**
   * Stable slots that only reference slot props or context state. The slot
   * can fully capture its own dependencies so when passed down the parent won't
   * need to force the child to update.
   */
  // 当前插槽处于稳定状态
  /*
    <Comp>
        <template v-slot:default></template>
    </Comp>
  */
  STABLE = 1,
  /**
   * Slots that reference scope variables (v-for or an outer slot prop), or
   * has conditional structure (v-if, v-for). The parent will need to force
   * the child to update because the slot does not fully capture its dependencies.
   */
  // 表示插槽处于动态状态，插槽结构可能发生改变
  /*
    <Comp>
        <template v-slot:default v-if="a"></template>
    </Comp>
  */
  DYNAMIC = 2,
  /**
   * `<slot/>` being forwarded into a child component. Whether the parent needs
   * to update the child is dependent on what kind of slots the parent itself
   * received. This has to be refined at runtime, when the child's vnode
   * is being created (in `normalizeChildren`)
   */
  // 表示插槽处于转发状态
  /*
    <Comp>
        <template v-slot:default></template>
    </Comp>
  */
  FORWARDED = 3
}

/**
 * Dev only
 */
export const slotFlagsText = {
  [SlotFlags.STABLE]: 'STABLE',

  [SlotFlags.DYNAMIC]: 'DYNAMIC',

  [SlotFlags.FORWARDED]: 'FORWARDED'
}
