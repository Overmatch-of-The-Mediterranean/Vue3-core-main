import {
  isRef,
  isShallow,
  Ref,
  ComputedRef,
  ReactiveEffect,
  isReactive,
  ReactiveFlags,
  EffectScheduler,
  DebuggerOptions,
  getCurrentScope
} from '@vue/reactivity'
import { SchedulerJob, queueJob } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject,
  extend
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'
import { useSSRContext } from '@vue/runtime-core'

export type WatchEffect = (onCleanup: OnCleanup) => void

// 数据源支持传入单个ref，computed响应式对象或者传入一个返回相同泛型类型的函数
export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

// 回调函数cb，传入的三个参数
export type WatchCallback<V = any, OV = any> = (
  value: V, // 新值
  oldValue: OV, // 旧值
  onCleanup: OnCleanup // 用于注册过期函数的函数
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : T[K] extends object
      ? Immediate extends true
        ? T[K] | undefined
        : T[K]
      : never
}

type OnCleanup = (cleanupFn: () => void) => void

export interface WatchOptionsBase extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync' // 决定回调函数的执行时机
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate // 是否立即执行一次
  deep?: boolean // 是否深度监听
}

export type WatchStopHandle = () => void

// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// DOM更新完成后，再触发回调的watchEffect，通过flush = 'post'的配置项实现
export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'post' }) : { flush: 'post' }
  )
}

// 同步的watchEffect通过设置flush = 'sync'实现
export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    __DEV__ ? extend({}, options as any, { flush: 'sync' }) : { flush: 'sync' }
  )
}

// 作为初始化oldValue的值，后续第一次执行回调函数cb时，通过这个标识把oldValue更新为undefined
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  // 开发模式下，cb不是函数直接报警告
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}

// watch和watchEffect真正的逻辑
// 通过是否存在回调函数cb判断是 watch 调用还是 watchEffect 调用
// 本质上就是利用effect和scheduler实现的
function doWatch(
  // 监听的数据源
  source: WatchSource | WatchSource[] | WatchEffect | object,
  // 响应式数据改变，执行的回调函数
  cb: WatchCallback | null,
  {
    immediate, // cb是否立即执行一次
    deep, // 深度监听
    flush, // 控制回调函数cb的执行时机
    onTrack,
    onTrigger
  }: WatchOptions = EMPTY_OBJ
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }
  // 数据源不合法时的报错信息函数
  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }
  /* 此时的 instance 是当前正在初始化操作的 instance  */
  const instance =
    getCurrentScope() === currentInstance?.scope ? currentInstance : null

  // getter函数在后面用于属性和副作用函数建立响应联系，getter就是run中的fn
  // 其作用就是为了建立相应联系和获取最新值
  let getter: () => any
  // 标志是否强制触发更新
  let forceTrigger = false
  // 标记传入的是单个数据源还是以数组形式传入的多个数据源
  let isMultiSource = false

  // 对传入参数的处理，根据参数类型生成不同的getter，以便getter执行时能建立数据源与副作用函数的响应联系
  if (isRef(source)) {
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    getter = () => source
    // reactive响应类型开启深度监视，外部的deep选项失效
    deep = true
  } else if (isArray(source)) {
    isMultiSource = true
    // 当source数组中有响应式的数据返回值为true，代表要强制触发更新
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      // getter函数里面其实就是对于数组中每个元素，如果是响应式数据的话，就让其与副作用函数建立联系
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // 有source，有cb，此时是watch场景
      // source是函数且有回调函数
      // source = () => obj.foo
      // getter = () => source() 本质上等价于 getter = () => obj.foo
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // source是函数，却没有cb回调函数，说明此时是watchEffect场景
      // 为watchEffect设置getter函数
      getter = () => {
        // 如果已经卸载，则watchEffect(source)的source不需要执行，也就是不需要建立响应联系，直接返回
        if (instance && instance.isUnmounted) {
          return
        }
        // 有过期函数，执行过期函数
        if (cleanup) {
          cleanup()
        }
        // 相当于 source()
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onCleanup]
        )
      }
    }
  } else {
    // 如果source不是以上情况，将getter设置为空，并报出source不合法的警报
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 2.x array mutation watch compat
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        traverse(val)
      }
      return val
    }
  }

  // 深度监听
  if (cb && deep) {
    const baseGetter = getter
    // 遍历响应式数据的每个属性，建立响应联系
    getter = () => traverse(baseGetter())
  }

  /*
      通过注册过期函数来解决回调函数中有异步操作导致的竞态问题。每次数据改变后，要执行其副作用函数，也就是执行该副作用函数身上绑定的调度器。
      调度器中才会真正执行传给watch的callback，执行callback前，会执行上次副作用函数中注册的过期函数，从而使得上次的执行过期。
  */
  let cleanup: (() => void) | undefined // 过期函数

  // 注册过期函数
  let onCleanup: OnCleanup = (fn: () => void) => {
    // 利用了闭包
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
      cleanup = effect.onStop = undefined
    }
  }

  let ssrCleanup: (() => void)[] | undefined
  if (__SSR__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    onCleanup = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        isMultiSource ? [] : undefined,
        onCleanup
      ])
    }
    if (flush === 'sync') {
      const ctx = useSSRContext()!
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = [])
    } else {
      return NOOP
    }
  }

  // 初始化oldValue
  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  const job: SchedulerJob = () => {
    // active为false说明副作用停用，该副作用函数执行了stop，消除了依赖集合与副作用函数的联系
    if (!effect.active) {
      return
    }

    // 有cb是watch的job的执行情况，没有cb是watchEffect的job的执行情况
    if (cb) {
      // 每次响应式数据更新后，触发回调前，需要得到更新后的新值
      const newValue = effect.run() // 相当于执行getter()

      // 深度监听，强制更新以及判断数据源的值改变，则执行回调函数cb
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : hasChanged(newValue, oldValue)) ||
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // 每次执行回调前，调用上次回调注册的过期函数，使得上次回调过期
        if (cleanup) {
          cleanup()
        }

        // 相当于 cb(oldValue, newValue, onCleanup)
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE
            ? undefined
            : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
              ? []
              : oldValue,
          onCleanup
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect
      effect.run()
    }
  }

  // 重要：让调度器任务作为侦听器的回调以至于调度器能知道它可以被允许自己派发更新
  job.allowRecurse = !!cb

  let scheduler: EffectScheduler
  // 处理回调函数在不同调用时机下，scheduler调度job的执行情况
  if (flush === 'sync') {
    scheduler = job as any // 调度器任务直接执行
  } else if (flush === 'post') {
    // 调度函数要将副作用函数放在微任务队列中，等待DOM更新完成后再执行
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre'
    // 此任务为前置任务，DOM更新前执行
    job.pre = true
    if (instance) job.id = instance.uid
    scheduler = () => queueJob(job)
  }

  const effect = new ReactiveEffect(getter, scheduler)

  if (__DEV__) {
    effect.onTrack = onTrack
    effect.onTrigger = onTrigger
  }

  // 初始化调用副作用
  if (cb) {
    // 无论立即执行与否，都会建立响应联系
    if (immediate) {
      job()
    } else {
      // 有cb，但不是立即执行的，需要执行副作用函数(本质上就是执行上面处理好的getter获取值)，准备好传递给cb的参数
      oldValue = effect.run()
    }
  }

  // 如果调用时机为 post，则推入延迟执行队列
  else if (flush === 'post') {
    queuePostRenderEffect(
      effect.run.bind(effect),
      instance && instance.suspense
    )
  } else {
    // watchEffect会立即执行一次，收集依赖
    effect.run()
  }

  // 返回取消监听的函数，本质上就是从依赖集合中删除该副作用函数，去除响应联系
  const unwatch = () => {
    effect.stop()
    if (instance && instance.scope) {
      remove(instance.scope.effects!, effect)
    }
  }

  if (__SSR__ && ssrCleanup) ssrCleanup.push(unwatch)
  return unwatch
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  const cur = currentInstance
  setCurrentInstance(this)
  const res = doWatch(getter, cb.bind(publicThis), options)
  if (cur) {
    setCurrentInstance(cur)
  } else {
    unsetCurrentInstance()
  }
  return res
}

// 初始化组件过程中的applyOptions函数里面，创建watcher时会使用
export function createPathGetter(ctx: any, path: string) {
  const segments = path.split('.')
  return () => {
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}

// 对数据源中的每个属性递归遍历进行监听
export function traverse(value: unknown, seen?: Set<unknown>) {
  // value是普通值的情况
  if (!isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }
  seen = seen || new Set()
  if (seen.has(value)) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
