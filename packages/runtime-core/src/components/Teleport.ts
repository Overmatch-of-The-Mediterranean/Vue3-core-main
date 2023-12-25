import { ComponentInternalInstance } from '../component'
import { SuspenseBoundary } from './Suspense'
import {
  RendererInternals,
  MoveType,
  RendererElement,
  RendererNode,
  RendererOptions,
  traverseStaticChildren
} from '../renderer'
import { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { isString, ShapeFlags } from '@vue/shared'
import { warn } from '../warning'
import { isHmrUpdating } from '../hmr'

export type TeleportVNode = VNode<RendererNode, RendererElement, TeleportProps>

export interface TeleportProps {
  to: string | RendererElement | null | undefined
  disabled?: boolean
}

export const isTeleport = (type: any): boolean => type.__isTeleport

const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

const isTargetSVG = (target: RendererElement): boolean =>
  typeof SVGElement !== 'undefined' && target instanceof SVGElement

// 获取要目标挂载点
const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector']
): T | null => {
  
  const targetSelector = props && props.to
  // 如果是字符串类型，则将其对应的DOM选择出来并返回
  // 如果不是字符串类型，则直接返回
  if (isString(targetSelector)) {
    if (!select) {
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`
        )
      return null
    } else {
      const target = select(targetSelector)
      if (!target) {
        __DEV__ &&
          warn(
            `Failed to locate Teleport target with selector "${targetSelector}". ` +
              `Note the target element must exist before the component is mounted - ` +
              `i.e. the target cannot be rendered by the component itself, and ` +
              `ideally should be outside of the entire Vue component tree.`
          )
      }
      return target as T
    }
  } else {
    if (__DEV__ && !targetSelector && !isTeleportDisabled(props)) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    return targetSelector as T
  }
}

export const TeleportImpl = {
  name: 'Teleport',
  // 打上teleport组件的标记
  __isTeleport: true,
  process(
    n1: TeleportVNode | null,
    n2: TeleportVNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean,
    internals: RendererInternals // 渲染器传递的一些方法
  ) {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment }
    } = internals

    const disabled = isTeleportDisabled(n2.props)
    let { shapeFlag, children, dynamicChildren } = n2

    // #3302
    // HMR updated, force full diff
    if (__DEV__ && isHmrUpdating) {
      optimized = false
      dynamicChildren = null
    }

    // telepot的渲染逻辑被单独的抽离出来。但其渲染思路和渲染器本身的渲染思路一样，只不过是为了不让渲染器代码“膨胀”，且可以在不用时treeShaking掉才将其抽离出来。
    if (n1 == null) {
      // 挂载逻辑
      // 创建teleport的开始和结束节点，即，将要移动的元素移动到这两个元素之间。确立teleport的渲染区域。
      // 在不允许teleport时，要移动的元素还是要在原容器中渲染。这两个节点就是在原容器中使用的。
      // 注释节点就是占位用的，标识 teleport 原来的位置。
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText(''))
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText(''))
      // 插入原容器中，确立渲染区域
      insert(placeholder, container, anchor)
      insert(mainAnchor, container, anchor)
      // 获取挂载点
      const target = (n2.target = resolveTarget(n2.props, querySelector))
      // 获取锚点
      const targetAnchor = (n2.targetAnchor = createText(''))
      
      if (target) {
        // 如果有目标挂载点
        // 将teleport组件中要移动的元素所参照的锚点插入到挂载点中作为其孩子，这样就与目标挂载点建立了联系。
        insert(targetAnchor, target)
        // #2652 we could be teleporting from a non-SVG tree into an SVG tree
        isSVG = isSVG || isTargetSVG(target)
      } else if (__DEV__ && !disabled) {
        warn('Invalid Teleport target on mount:', target, `(${typeof target})`)
      }

      // 挂载函数
      const mount = (container: RendererElement, anchor: RendererNode) => {
        // teleport总是有Array children，这是因为在编辑器和vnode Children标准化时都是强制的
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            children as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        }
      }

      
      if (disabled) {
        // disabled为true，代表禁用了teleport，这时将teleport中的children挂载到原来的容器中
        mount(container, mainAnchor)
      } else if (target) {
        // 允许teleport且有挂载点，则将teleport中的children挂载到目标容器中
        mount(target, targetAnchor)
      }
    } else {
      // 更新逻辑
      n2.el = n1.el
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      const wasDisabled = isTeleportDisabled(n1.props)
      // 根据是否允许teleport来确定要渲染到那个容器中
      const currentContainer = wasDisabled ? container : target
      // 根据是否允许teleport来确定渲染到容器中所参照的锚点，原容器参照mainAnchor，目标容器参照targetAnchor
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor
      isSVG = isSVG || isTargetSVG(target)
      // 如果有动态节点的话，对动态节点进行更新
      if (dynamicChildren) {
        // fast path when the teleport happens to be a block root
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds
        )
        // even in block tree mode we need to make sure all root-level nodes
        // in the teleport inherit previous DOM references so that they can
        // be moved in future patches.
        traverseStaticChildren(n1, n2, true)
      }
      else if (!optimized) {
        // 否则就全量更新 
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          false
        )
      }

      if (disabled) {
        if (!wasDisabled) {
          // 上次渲染允许teleport，这次渲染不允许teleport，则将这次渲染的内容渲染到原容器中。
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        } else {
          // 上次和这次渲染都不允许teleport。反正也不能移动，还是呆在原容器中。但to属性改变，还是需要更新一下to属性。
          if (n2.props && n1.props && n2.props.to !== n1.props.to) {
            n2.props.to = n1.props.to
          }
        }
      } else {
        // 无论上次是否允许teleport，只要这次允许teleport就需要处理好target，并将DOM元素移动到挂载点中
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          // 上次和这次都允许移动
          // 渲染的目标挂载点改变，获取新的挂载点
          const nextTarget = (n2.target = resolveTarget(
            n2.props,
            querySelector
          ))
          
          // 如果存在新的挂载点，则移动到新的挂载点中
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`
            )
          }
        } else if (wasDisabled) {
          // wasDisabled为true，disabled为false，说明由不可移动变为可移动，则将DOM元素移动到目标挂载点
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      }
    }

    updateCssVars(n2)
  },
  // 移除teleport组件
  remove(
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean,
    { um: unmount, o: { remove: hostRemove } }: RendererInternals,
    doRemove: boolean
  ) {
    const { shapeFlag, children, anchor, targetAnchor, target, props } = vnode
    // 如果有目标挂载点，则将目标锚点从中移除
    if (target) {
      hostRemove(targetAnchor!)
    }

    // an unmounted teleport should always unmount its children whether it's disabled or not
    // 一个未挂载的teleport应该总是卸载它的children，不管它是否被禁用
    doRemove && hostRemove(anchor!)
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      // 主动remove或非disabled的情况下要将挂载的节点销毁
      const shouldRemove = doRemove || !isTeleportDisabled(props)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        const child = (children as VNode[])[i]
        unmount(
          child,
          parentComponent,
          parentSuspense,
          shouldRemove,
          !!child.dynamicChildren
        )
      }
    }
  },

  move: moveTeleport,
  hydrate: hydrateTeleport
}

// 移动类型
export const enum TeleportMoveTypes {
  TARGET_CHANGE,
  TOGGLE, // enable / disable
  REORDER // moved in the main view
}

// 真正执行移动的逻辑
function moveTeleport(
  vnode: VNode, // teleport组件对应的vnode
  container: RendererElement, // 移动到的目标容器
  parentAnchor: RendererNode | null, // 移动是参照的锚点
  { o: { insert }, m: move }: RendererInternals, // 获取渲染器提供的方法
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER
) {
  // move target anchor if this is a target change.
  // 如果这是一个目标更改类型，移动目标锚。将目标锚移动到目标容器中
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  
  const { el, anchor, shapeFlag, children, props } = vnode
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  /*
     如果这是一个重新排序且teleport是可用的(内容在target中)，不用移动children。
     相反，如果不是重新排序，且teleport被禁止，则需要移动children
  */
  
  /*
     1.不是重新排序，不管teleport是否被禁止。这种情况处理的是TARGET_CHANGE和TOGGLE类型的移动。这两种类型都需要移动DOM元素。
       TARGET_CHANGE是要移动到新的target中; TOGGLE在原容器和target之间移动
     2.是重新排序，teleport被禁用。
     3.是重新排序，teleport被允许。
  */
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    // teleport可能有子节点，可能没有子节点
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      // 有子节点需要将其移动到目标容器中
      // 对于TARGET_CHANGE类型的移动，container是新的target
      // 对于TOGGLE类型的移动，container是target
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

function hydrateTeleport(
  node: Node,
  vnode: TeleportVNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  slotScopeIds: string[] | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector }
  }: RendererInternals<Node, Element>,
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  const target = (vnode.target = resolveTarget<Element>(
    vnode.props,
    querySelector
  ))
  if (target) {
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (isTeleportDisabled(vnode.props)) {
        vnode.anchor = hydrateChildren(
          nextSibling(node),
          vnode,
          parentNode(node)!,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
        vnode.targetAnchor = targetNode
      } else {
        vnode.anchor = nextSibling(node)

        // lookahead until we find the target anchor
        // we cannot rely on return value of hydrateChildren() because there
        // could be nested teleports
        let targetAnchor = targetNode
        while (targetAnchor) {
          targetAnchor = nextSibling(targetAnchor)
          if (
            targetAnchor &&
            targetAnchor.nodeType === 8 &&
            (targetAnchor as Comment).data === 'teleport anchor'
          ) {
            vnode.targetAnchor = targetAnchor
            ;(target as TeleportTargetElement)._lpa =
              vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
            break
          }
        }

        hydrateChildren(
          targetNode,
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
      }
    }
    updateCssVars(vnode)
  }
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = TeleportImpl as unknown as {
  __isTeleport: true
  new (): {
    $props: VNodeProps & TeleportProps
    $slots: {
      default(): VNode[]
    }
  }
}

function updateCssVars(vnode: VNode) {
  // presence of .ut method indicates owner component uses css vars.
  // code path here can assume browser environment.
  const ctx = vnode.ctx
  if (ctx && ctx.ut) {
    let node = (vnode.children as VNode[])[0].el!
    while (node && node !== vnode.targetAnchor) {
      if (node.nodeType === 1) node.setAttribute('data-v-owner', ctx.uid)
      node = node.nextSibling
    }
    ctx.ut()
  }
}
