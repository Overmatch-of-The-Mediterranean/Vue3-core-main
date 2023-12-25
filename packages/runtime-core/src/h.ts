import {
  VNode,
  VNodeProps,
  createVNode,
  VNodeArrayChildren,
  Fragment,
  Text,
  Comment,
  isVNode
} from './vnode'
import { Teleport, TeleportProps } from './components/Teleport'
import { Suspense, SuspenseProps } from './components/Suspense'
import { isObject, isArray } from '@vue/shared'
import { RawSlots } from './componentSlots'
import {
  FunctionalComponent,
  Component,
  ComponentOptions,
  ConcreteComponent
} from './component'
import { EmitsOptions } from './componentEmits'
import { DefineComponent } from './apiDefineComponent'

// `h` is a more user-friendly version of `createVNode` that allows omitting the
// props when possible. It is intended for manually written render functions.
// Compiler-generated code uses `createVNode` because
// 1. it is monomorphic and avoids the extra call overhead
// 2. it allows specifying patchFlags for optimization

/*
// type only
h('div')

// type + props
h('div', {})

// type + omit props + children
// Omit props does NOT support named slots
h('div', []) // array
h('div', 'foo') // text
h('div', h('br')) // vnode
h(Component, () => {}) // default slot

// type + props + children
h('div', {}, []) // array
h('div', {}, 'foo') // text
h('div', {}, h('br')) // vnode
h(Component, {}, () => {}) // default slot
h(Component, {}, {}) // named slots

// named slots without props requires explicit `null` to avoid ambiguity
h(Component, null, {})
**/

type RawProps = VNodeProps & {
  // used to differ from a single VNode object as children
  __v_isVNode?: never
  // used to differ from Array children
  [Symbol.iterator]?: never
} & Record<string, any>

type RawChildren =
  | string
  | number
  | boolean
  | VNode
  | VNodeArrayChildren
  | (() => any)

// fake constructor type returned from `defineComponent`
interface Constructor<P = any> {
  __isFragment?: never
  __isTeleport?: never
  __isSuspense?: never
  new (...args: any[]): { $props: P }
}

// The following is a series of overloads for providing props validation of
// manually written render functions.

// element
export function h(type: string, children?: RawChildren): VNode
export function h(
  type: string,
  props?: RawProps | null,
  children?: RawChildren | RawSlots
): VNode

// text/comment
export function h(
  type: typeof Text | typeof Comment,
  children?: string | number | boolean
): VNode
export function h(
  type: typeof Text | typeof Comment,
  props?: null,
  children?: string | number | boolean
): VNode
// fragment
export function h(type: typeof Fragment, children?: VNodeArrayChildren): VNode
export function h(
  type: typeof Fragment,
  props?: RawProps | null,
  children?: VNodeArrayChildren
): VNode

// teleport (target prop is required)
export function h(
  type: typeof Teleport,
  props: RawProps & TeleportProps,
  children: RawChildren | RawSlots
): VNode

// suspense
export function h(type: typeof Suspense, children?: RawChildren): VNode
export function h(
  type: typeof Suspense,
  props?: (RawProps & SuspenseProps) | null,
  children?: RawChildren | RawSlots
): VNode

// functional component
export function h<
  P,
  E extends EmitsOptions = {},
  S extends Record<string, any> = {}
>(
  type: FunctionalComponent<P, E, S>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots
): VNode

// catch-all for generic component types
export function h(type: Component, children?: RawChildren): VNode

// concrete component
export function h<P>(
  type: ConcreteComponent | string,
  children?: RawChildren
): VNode
export function h<P>(
  type: ConcreteComponent<P> | string,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren
): VNode

// component without props
export function h<P>(
  type: Component<P>,
  props?: (RawProps & P) | null,
  children?: RawChildren | RawSlots
): VNode

// exclude `defineComponent` constructors
export function h<P>(
  type: ComponentOptions<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots
): VNode

// fake constructor type returned by `defineComponent` or class component
export function h(type: Constructor, children?: RawChildren): VNode
export function h<P>(
  type: Constructor<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots
): VNode

// fake constructor type returned by `defineComponent`
export function h(type: DefineComponent, children?: RawChildren): VNode
export function h<P>(
  type: DefineComponent<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots
): VNode

// catch all types
export function h(type: string | Component, children?: RawChildren): VNode
export function h<P>(
  type: string | Component<P>,
  props?: (RawProps & P) | ({} extends P ? null : never),
  children?: RawChildren | RawSlots
): VNode

// h函数内部本质上是通过调用createVNode来创建并返回vnode
// 内部的条件判断是对参数的处理，因为createVnode(type, props, children:数组类型)
export function h(type: any, propsOrChildren?: any, children?: any): VNode {
  const l = arguments.length
  // 传递两个参数的处理
  if (l === 2) {
    // 如果第二个参数是对象，不是数组，第二个参数有两种情况(props和vnode)
    if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
      // single vnode without props
      // 第二个参数是vnode，则说明该vnode没有props
      if (isVNode(propsOrChildren)) {
        return createVNode(type, null, [propsOrChildren])
      }
      // 否则，第二个参数是props，该vnode没有子节点
      return createVNode(type, propsOrChildren)
    } else {
      // omit props
      // 来到这里，说明第二个参数是一组子节点，且该vnode没有props
      return createVNode(type, null, propsOrChildren)
    }
  } else {
    if (l > 3) {
      // 如果参数长度大于三
      // 则从索引的第二位往后都是子vnode，需要将其整理到children数组中
      children = Array.prototype.slice.call(arguments, 2)
    } else if (l === 3 && isVNode(children)) {
      // 如果索引等于三，且第三位是vnode
      // 说明该vnode有一个子vnode
      children = [children]
    }
    // 传入的参数符合createVnode的要求，不需要处理的情况
    return createVNode(type, propsOrChildren, children)
  }
}
