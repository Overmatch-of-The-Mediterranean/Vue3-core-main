export const enum ShapeFlags {
  ELEMENT = 1,
  FUNCTIONAL_COMPONENT = 1 << 1, // 2，函数式组件
  STATEFUL_COMPONENT = 1 << 2, // 4，有状态组件
  TEXT_CHILDREN = 1 << 3, // 8，文本子节点
  ARRAY_CHILDREN = 1 << 4, // 16，子节点是数组
  SLOTS_CHILDREN = 1 << 5, // 32，子节点包含插槽
  TELEPORT = 1 << 6,
  SUSPENSE = 1 << 7,
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8,
  COMPONENT_KEPT_ALIVE = 1 << 9,
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT // 10 | 100 = 110 ->6，表示所有组件
}
