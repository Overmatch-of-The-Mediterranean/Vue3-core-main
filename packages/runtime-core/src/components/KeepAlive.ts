import {
  ConcreteComponent,
  getCurrentInstance,
  SetupContext,
  ComponentInternalInstance,
  currentInstance,
  getComponentName,
  ComponentOptions
} from '../component'
import {
  VNode,
  cloneVNode,
  isVNode,
  VNodeProps,
  invokeVNodeHook,
  isSameVNodeType
} from '../vnode'
import { warn } from '../warning'
import {
  onBeforeUnmount,
  injectHook,
  onUnmounted,
  onMounted,
  onUpdated
} from '../apiLifecycle'
import {
  isString,
  isArray,
  isRegExp,
  ShapeFlags,
  remove,
  invokeArrayFns
} from '@vue/shared'
import { watch } from '../apiWatch'
import {
  RendererInternals,
  queuePostRenderEffect,
  MoveType,
  RendererElement,
  RendererNode
} from '../renderer'
import { setTransitionHooks } from './BaseTransition'
import { ComponentRenderContext } from '../componentPublicInstance'
import { devtoolsComponentAdded } from '../devtools'
import { isAsyncWrapper } from '../apiAsyncComponent'
import { isSuspense } from './Suspense'
import { LifecycleHooks } from '../enums'

type MatchPattern = string | RegExp | (string | RegExp)[]

export interface KeepAliveProps {
  include?: MatchPattern
  exclude?: MatchPattern
  max?: number | string
}

type CacheKey = string | number | symbol | ConcreteComponent
type Cache = Map<CacheKey, VNode>
type Keys = Set<CacheKey>

export interface KeepAliveContext extends ComponentRenderContext {
  renderer: RendererInternals
  activate: (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    isSVG: boolean,
    optimized: boolean
  ) => void
  deactivate: (vnode: VNode) => void
}

export const isKeepAlive = (vnode: VNode): boolean =>
  (vnode.type as any).__isKeepAlive

// KeepAlive实现
// KeepAlive的本质其实就是创建一个隐藏容器，当卸载KeepAlive包裹的组件时，调用deActivate回调函数，将被包裹组件从原容器移动到隐藏容器
// 当重新挂载被包裹组件时，调用activate回调函数，将组件从隐藏容器移动到原容器
const KeepAliveImpl: ComponentOptions = {
  name: `KeepAlive`,

  // Marker for special handling inside the renderer. We are not using a ===
  // check directly on KeepAlive in the renderer, because importing it directly
  // would prevent it from being tree-shaken.
  
  // 标识是不是KeepAlive组件
  __isKeepAlive: true,
  
  // KeepAlive支持传的属性
  props: {
    include: [String, RegExp, Array], // 指定哪些组件进行keepAlive
    exclude: [String, RegExp, Array], // 指定那些组件不进行keepAlive
    max: [String, Number] // 进行keepAlive的组件的最大数
  },

  setup(props: KeepAliveProps, { slots }: SetupContext) {
    // 当前KeepAlive组件实例
    const instance = getCurrentInstance()!

    // KeepAlive实例上会有一个keepAliveCtx，它是由渲染器注入的
    // 它上面存在渲染器提供的一些方法
    const sharedContext = instance.ctx as KeepAliveContext

    // if the internal renderer is not registered, it indicates that this is server-side rendering,
    // for KeepAlive, we just need to render its children
    if (__SSR__ && !sharedContext.renderer) {
      return () => {
        const children = slots.default && slots.default()
        return children && children.length === 1 ? children[0] : children
      }
    }

    // 创建一个缓存对象
    // 如果vnode有vnode.key则key是vnode.key,否则key是vnode.type
    // value是vnode
    const cache: Cache = new Map()
    
    // 记录cache中的key，在后续从cache中换出组件和换入组件时使用
    // 使用其可以知道当超过max时，那个组件需要被换出。并且也可以通过操作它来保持被换入组件的新鲜度
    const keys: Keys = new Set()
    let current: VNode | null = null

    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      ;(instance as any).__v_cache = cache
    }

    const parentSuspense = instance.suspense

    // 渲染器提供的方法
    const {
      renderer: {
        p: patch, // 对组件进行更新的函数
        m: move, // 将被缓存的组件在原容器和隐藏容器之间移动的函数
        um: _unmount,// 卸载组件的函数，主要针对被从cache换出的组件
        o: { createElement } // 创建隐藏容器使用
      }
    } = sharedContext
    const storageContainer = createElement('div')

    // KeepAlive实例上定义activate
    sharedContext.activate = (vnode, container, anchor, isSVG, optimized) => {
       
      const instance = vnode.component!
      // 将vnode移动到原容器中
      move(vnode, container, anchor, MoveType.ENTER, parentSuspense)
      // 将要激活的vnode进行patch，因为在失活的期间props可能发生了改变
      patch(
        instance.vnode,
        vnode,
        container,
        anchor,
        instance,
        parentSuspense,
        isSVG,
        vnode.slotScopeIds,
        optimized
      )
      // 组件挂载被放入原容器后，再调用activate的回调钩子，因此需要放入后置队列中
      queuePostRenderEffect(() => {
        instance.isDeactivated = false
        if (instance.a) {
          invokeArrayFns(instance.a)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeMounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }
    }
    // KeepAlive实例上定义deActivate
    sharedContext.deactivate = (vnode: VNode) => {
      const instance = vnode.component!
      // 将vnode移动到隐藏容器中
      move(vnode, storageContainer, null, MoveType.LEAVE, parentSuspense)
      // 组件被卸载放入隐藏容器后，再调用deactivate的回调钩子，因此需要放入后置队列中
      queuePostRenderEffect(() => {
        if (instance.da) {
          invokeArrayFns(instance.da)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeUnmounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
        instance.isDeactivated = true
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }
    }

    // 在缓存的组件数目超过预定最大数目时，用来对换出的组件进行卸载
    function unmount(vnode: VNode) {
      // reset the shapeFlag so it can be properly unmounted
      resetShapeFlag(vnode)
      _unmount(vnode, instance, parentSuspense, true)
    }

    // 删除缓存，当缓存的组件超过最大数目，需要根据换出策略，将相应的组件换出，将当前组件换入
    function pruneCache(filter?: (name: string) => boolean) {
      cache.forEach((vnode, key) => {
        const name = getComponentName(vnode.type as ConcreteComponent)
        if (name && (!filter || !filter(name))) {
          pruneCacheEntry(key)
        }
      })
    }

    function pruneCacheEntry(key: CacheKey) {
      const cached = cache.get(key) as VNode
      // current是不需要缓存的组件，但现在不能进行卸载
      // 判断不再缓存的组件是不是current
      if (!current || !isSameVNodeType(cached, current)) {
        // 对不再缓存且不是current的组件进行卸载
        unmount(cached)
      } else if (current) {
      // 当前活动实例不再保持活动状态。
      // 我们现在不能卸载它，但以后可能会卸载，所以现在重置它的标志。
        resetShapeFlag(current)
      }
      cache.delete(key)
      keys.delete(key)
    }

    // prune cache on include/exclude prop change
    // 根据include/exclude属性的改变决定将那些组件从缓存中删除，对include/exclude进行监听
    watch(
      () => [props.include, props.exclude],
      ([include, exclude]) => {
        include && pruneCache(name => matches(include, name))
        exclude && pruneCache(name => !matches(exclude, name))
      },
      // prune post-render after `current` has been updated
      { flush: 'post', deep: true }
    )

    // cache sub tree after render
    let pendingCacheKey: CacheKey | null = null
    const cacheSubtree = () => {
      // fix #1621, the pendingCacheKey could be 0
      if (pendingCacheKey != null) {
        cache.set(pendingCacheKey, getInnerChild(instance.subTree))
      }
    }
    onMounted(cacheSubtree)
    onUpdated(cacheSubtree)

    onBeforeUnmount(() => {
      cache.forEach(cached => {
        const { subTree, suspense } = instance
        const vnode = getInnerChild(subTree)
        if (cached.type === vnode.type && cached.key === vnode.key) {
          // current instance will be unmounted as part of keep-alive's unmount
          resetShapeFlag(vnode)
          // but invoke its deactivated hook here
          const da = vnode.component!.da
          da && queuePostRenderEffect(da, suspense)
          return
        }
        unmount(cached)
      })
    })

    return () => {
      pendingCacheKey = null

      if (!slots.default) {
        return null
      }
      // 被包裹的组件被解析成插槽
      const children = slots.default()
      const rawVNode = children[0]
      if (children.length > 1) {
        if (__DEV__) {
          warn(`KeepAlive should contain exactly one component child.`)
        }
        current = null
        return children
      } else if (
        !isVNode(rawVNode) ||
        (!(rawVNode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) &&
          !(rawVNode.shapeFlag & ShapeFlags.SUSPENSE))
      ) {
        current = null
        return rawVNode
      }

      let vnode = getInnerChild(rawVNode)
      const comp = vnode.type as ConcreteComponent

      // 对于异步组件，名称检查应该基于它加载器的状态返回的组件
      // 内部组件(如果可用)
      // 获取组件名字
      const name = getComponentName(
        isAsyncWrapper(vnode) // 判断是否是异步组件返回的包装组件
          ? (vnode.type as ComponentOptions).__asyncResolved || {}
          : comp
      )
      
      const { include, exclude, max } = props
      // 根据include和exclude判断该组件是否需要被缓存
      if (
        (include && (!name || !matches(include, name))) ||
        (exclude && name && matches(exclude, name))
      ) {
        // 如果该组件的name不在include或者在exclude，则不需要被缓存，直接返回原vnode
        current = vnode
        return rawVNode
      }

      // 判断缓存对象中的键是vnode.key还是vnode.type
      const key = vnode.key == null ? comp : vnode.key
      const cachedVNode = cache.get(key)

      // clone vnode if it's reused because we are going to mutate it
      if (vnode.el) {
        vnode = cloneVNode(vnode)
        if (rawVNode.shapeFlag & ShapeFlags.SUSPENSE) {
          rawVNode.ssContent = vnode
        }
      }
      // #1513 it's possible for the returned vnode to be cloned due to attr
      // fallthrough or scopeId, so the vnode here may not be the final vnode
      // that is mounted. Instead of caching it directly, we store the pending
      // key and cache `instance.subTree` (the normalized vnode) in
      // beforeMount/beforeUpdate hooks.
      
      // 等待被缓存的key
      pendingCacheKey = key

      if (cachedVNode) {
        // copy over mounted state
        vnode.el = cachedVNode.el
        vnode.component = cachedVNode.component
        if (vnode.transition) {
          // recursively update transition hooks on subTree
          setTransitionHooks(vnode, vnode.transition!)
        }
        // 避免vnode作为新挂载，对其打上keepAlive的标识
        vnode.shapeFlag |= ShapeFlags.COMPONENT_KEPT_ALIVE
        // make this key the freshest
        // 使这个key是最新的，这样在超过max换出时，该key不会被换出，符合LRU算法
        keys.delete(key)
        keys.add(key)
      } else {
        keys.add(key)
        // 当超过max限制时，删除cache中存在最长时间的。符合LRU算法
        if (max && keys.size > parseInt(max as string, 10)) {
          // keys.values()得到的是迭代器iterator，调用next获取的key就是需要被换出的组件
          pruneCacheEntry(keys.values().next().value)
        }
      }
      // avoid vnode being unmounted
      // 避免该组件在unmount时被卸载，给其打上COMPONENT_SHOULD_KEEP_ALIVE的标识
      vnode.shapeFlag |= ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE

      current = vnode
      return isSuspense(rawVNode.type) ? rawVNode : vnode
    }
  }
}

if (__COMPAT__) {
  KeepAliveImpl.__isBuildIn = true
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
export const KeepAlive = KeepAliveImpl as any as {
  __isKeepAlive: true
  new (): {
    $props: VNodeProps & KeepAliveProps
    $slots: {
      default(): VNode[]
    }
  }
}

// 在include和exclude中对组件的name进行匹配，以此决定该组件需不需要缓存
function matches(pattern: MatchPattern, name: string): boolean {
  if (isArray(pattern)) {
    // 传入字符数组的情况，['bar', 'foo']
    return pattern.some((p: string | RegExp) => matches(p, name))
  } else if (isString(pattern)) {
    // 传入字符串的情况，'bar,foo'
    return pattern.split(',').includes(name)
  } else if (isRegExp(pattern)) {
    // 使用正则进行匹配
    return pattern.test(name)
  }
  /* istanbul ignore next */
  return false
}

// 注册activated的回调函数
export function onActivated(
  hook: Function,
  target?: ComponentInternalInstance | null
) {
  registerKeepAliveHook(hook, LifecycleHooks.ACTIVATED, target)
}

// 注册onDeactivated的回调函数
export function onDeactivated(
  hook: Function,
  target?: ComponentInternalInstance | null
) {
  registerKeepAliveHook(hook, LifecycleHooks.DEACTIVATED, target)
}

// 注册KeepAlive组件的onActivated和onDeactivated生命周期钩子函数
function registerKeepAliveHook(
  hook: Function & { __wdc?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance | null = currentInstance
) {
  // cache the deactivate branch check wrapper for injected hooks so the same
  // hook can be properly deduped by the scheduler. "__wdc" stands for "with
  // deactivation check".
  const wrappedHook =
    hook.__wdc ||
    (hook.__wdc = () => {
      // only fire the hook if the target instance is NOT in a deactivated branch.
      let current: ComponentInternalInstance | null = target
      while (current) {
        if (current.isDeactivated) {
          return
        }
        current = current.parent
      }
      return hook()
    })
  injectHook(type, wrappedHook, target)
  // In addition to registering it on the target instance, we walk up the parent
  // chain and register it on all ancestor instances that are keep-alive roots.
  // This avoids the need to walk the entire component tree when invoking these
  // hooks, and more importantly, avoids the need to track child components in
  // arrays.
  if (target) {
    let current = target.parent
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current)
      }
      current = current.parent
    }
  }
}

function injectToKeepAliveRoot(
  hook: Function & { __weh?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance,
  keepAliveRoot: ComponentInternalInstance
) {
  // injectHook wraps the original for error handling, so make sure to remove
  // the wrapped version.
  const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */)
  onUnmounted(() => {
    remove(keepAliveRoot[type]!, injected)
  }, target)
}

function resetShapeFlag(vnode: VNode) {
  // bitwise operations to remove keep alive flags
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_KEPT_ALIVE
}

function getInnerChild(vnode: VNode) {
  return vnode.shapeFlag & ShapeFlags.SUSPENSE ? vnode.ssContent! : vnode
}
