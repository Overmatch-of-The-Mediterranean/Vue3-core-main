// https://juejin.cn/post/7156531823852388360#heading-5
import { ComponentInternalInstance, currentInstance } from './component'
import {
  VNode,
  VNodeNormalizedChildren,
  normalizeVNode,
  VNodeChild,
  InternalObjectKey
} from './vnode'
import {
  isArray,
  isFunction,
  EMPTY_OBJ,
  ShapeFlags,
  extend,
  def,
  SlotFlags,
  Prettify,
  IfAny
} from '@vue/shared'
import { warn } from './warning'
import { isKeepAlive } from './components/KeepAlive'
import { ContextualRenderFn, withCtx } from './componentRenderContext'
import { isHmrUpdating } from './hmr'
import { DeprecationTypes, isCompatEnabled } from './compat/compatConfig'
import { toRaw } from '@vue/reactivity'
import { trigger } from '@vue/reactivity'
import { TriggerOpTypes } from '@vue/reactivity'

export type Slot<T extends any = any> = (
  ...args: IfAny<T, any[], [T] | (T extends undefined ? [] : never)>
) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type Slots = Readonly<InternalSlots>

declare const SlotSymbol: unique symbol
export type SlotsType<T extends Record<string, any> = Record<string, any>> = {
  [SlotSymbol]?: T
}

export type StrictUnwrapSlotsType<
  S extends SlotsType,
  T = NonNullable<S[typeof SlotSymbol]>
> = [keyof S] extends [never] ? Slots : Readonly<T> & T

export type UnwrapSlotsType<
  S extends SlotsType,
  T = NonNullable<S[typeof SlotSymbol]>
> = [keyof S] extends [never]
  ? Slots
  : Readonly<
      Prettify<{
        [K in keyof T]: NonNullable<T[K]> extends (...args: any[]) => any
          ? T[K]
          : Slot<T[K]>
      }>
    >

export type RawSlots = {
  [name: string]: unknown
  // manual render fn hint to skip forced children updates
  $stable?: boolean
  /**
   * for tracking slot owner instance. This is attached during
   * normalizeChildren when the component vnode is created.
   * @internal
   */
  _ctx?: ComponentInternalInstance | null
  /**
   * indicates compiler generated slots
   * we use a reserved property instead of a vnode patchFlag because the slots
   * object may be directly passed down to a child component in a manual
   * render function, and the optimization hint need to be on the slot object
   * itself to be preserved.
   * @internal
   */
  _?: SlotFlags
}

const isInternalKey = (key: string) => key[0] === '_' || key === '$stable'

// 将插槽的返回值标准化为数组形式，并根据其值创建对应的vnode返回
const normalizeSlotValue = (value: unknown): VNode[] =>
  isArray(value)
    ? value.map(normalizeVNode)
    : [normalizeVNode(value as VNodeChild)]

// 包裹一层_withCtx
const normalizeSlot = (
  key: string,
  rawSlot: Function,
  ctx: ComponentInternalInstance | null | undefined
): Slot => {
  if ((rawSlot as any)._n) {
    // already normalized - #5353
    return rawSlot as Slot
  }
  const normalized = withCtx((...args: any[]) => {
    if (__DEV__ && currentInstance) {
      warn(
        `Slot "${key}" invoked outside of the render function: ` +
          `this will not track dependencies used in the slot. ` +
          `Invoke the slot function inside the render function instead.`
      )
    }
    return normalizeSlotValue(rawSlot(...args))
  }, ctx) as Slot
  // 表示不是编译器编译的slot，是用户手写的render函数
  ;(normalized as ContextualRenderFn)._c = false
  return normalized
}

// 将slots标准化成正常编译后的样子
/*
    <template>
        <Comp>
            我是插槽内容
        </Comp>
    </template>
    //编译后
    function render(_ctx, _cache) {
    const _component_Comp = _resolveComponent("Comp", true)

    return (_openBlock(),
            _createBlock(_component_Comp, null, {
        default: _withCtx(() => [
        _createTextVNode(" 我是插槽内容 ")
        ]),
        _: 1 
    }))
    }

*/

// 一个具名插槽对应一个创建好的VNode，我们这个例子只有default所以children对象中只有default；
// 并且必须由_withCtx包裹；(确保上下文，禁止block追踪)
// 参数必须是一个函数，不能是数组；(提升性能)
// 函数的返回值必须是一个数组。(标准化)

const normalizeObjectSlots = (
  rawSlots: RawSlots,
  slots: InternalSlots,
  instance: ComponentInternalInstance
) => {
  const ctx = rawSlots._ctx
  for (const key in rawSlots) {
    // _开头或者$stable跳过
    // 这将允许设置不进行标准化的插槽
    if (isInternalKey(key)) continue
    const value = rawSlots[key]
    // 如果是函数将其用_withCtx进行包裹
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx)
    } else if (value != null) {
      if (
        __DEV__ &&
        !(
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance)
        )
      ) {
        warn(
          `Non-function value encountered for slot "${key}". ` +
            `Prefer function slots for better performance.`
        )
      }
      // 对值进行标准化并且确保结果是数组类型
      const normalized = normalizeSlotValue(value)
      slots[key] = () => normalized
    }
  }
}

const normalizeVNodeSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  if (
    __DEV__ &&
    !isKeepAlive(instance.vnode) &&
    !(__COMPAT__ && isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance))
  ) {
    warn(
      `Non-function value encountered for default slot. ` +
        `Prefer function slots for better performance.`
    )
  }
  const normalized = normalizeSlotValue(children)
  instance.slots.default = () => normalized
}

/**
 * 做两件事：
 * 1.有slots，slots要是标准化的旧直接赋值instance.slots，否则将其进行标准化再赋值
 * 2.没有slots，将children进行标准化后赋值给instance.slots
 */
export const initSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  // 判断当前实例的children是否是slots
  if (instance.vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    // 判断slots是否是通过compiler编辑器的得到的
    const type = (children as RawSlots)._
    //有"_"标识表示是通过compiler编译得到的
    if (type) {
      instance.slots = toRaw(children as InternalSlots)
      // 将_属性变为不可枚举属性
      def(children as InternalSlots, '_', type)
    } else {
      /**
       * render(){
       *   return h(Comp,null,{
       *     default:()=>h("div",null),
       *     header:()=>h("div",null)
       *   })
       * }
       * 没有则表示用户自己写了render函数
       * 这个时候用户可能不会添加"_"属性
       * 所以需要对slots进行标准化
       */
      normalizeObjectSlots(
        children as RawSlots,
        (instance.slots = {}),
        instance
      )
    }
  } else {
    // 用户用数组或字符串或数字作为children
    // createVNode(Comp,null,[])就像这样。又或者createVNode(Comp,null,123)这样
    // 对createVNode的第三个参数只需要将其用函数包裹一层，再赋值给instance.slots就可以了
    instance.slots = {}
    if (children) {
      normalizeVNodeSlots(instance, children)
    }
  }
  def(instance.slots, InternalObjectKey, 1)
}

// 更新插槽
export const updateSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren,
  optimized: boolean
) => {
  const { vnode, slots } = instance
  let needDeletionCheck = true
  let deletionComparisonTarget = EMPTY_OBJ
  if (vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._
    if (type) {
      // compiled slots.
      if (__DEV__ && isHmrUpdating) {
        // Parent was HMR updated so slot content may have changed.
        // force update slots and mark instance for hmr as well
        extend(slots, children as Slots)
        trigger(instance, TriggerOpTypes.SET, '$slots')
      } else if (optimized && type === SlotFlags.STABLE) {
        // compiled AND stable.
        // no need to update, and skip stale slots removal.
        needDeletionCheck = false
      } else {
        // compiled but dynamic (v-if/v-for on slots) - update slots, but skip
        // normalization.
        extend(slots, children as Slots)
        // #2893
        // when rendering the optimized slots by manually written render function,
        // we need to delete the `slots._` flag if necessary to make subsequent updates reliable,
        // i.e. let the `renderSlot` create the bailed Fragment
        if (!optimized && type === SlotFlags.STABLE) {
          delete slots._
        }
      }
    } else {
      needDeletionCheck = !(children as RawSlots).$stable
      normalizeObjectSlots(children as RawSlots, slots, instance)
    }
    deletionComparisonTarget = children as RawSlots
  } else if (children) {
    // non slot object children (direct value) passed to a component
    normalizeVNodeSlots(instance, children)
    deletionComparisonTarget = { default: 1 }
  }

  // delete stale slots
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && deletionComparisonTarget[key] == null) {
        delete slots[key]
      }
    }
  }
}
